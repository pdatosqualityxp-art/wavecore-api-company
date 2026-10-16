import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORPORATE_TABLES = [
  'almacen',
  'clientes',
  'componentes',
  'compras',
  'establecimientos',
  'estados_intervencion',
  'intervenciones',
  'productos',
  'proveedores_compo',
  'proveedores_serv',
  'servicios_intervencion',
  'stock_compo',
  'stock_prod',
  'ventas',
];
const MAX_OUTPUT_TOKENS = 2048;
const OUTPUT_LIMIT_WARNING = 'La respuesta llegó al límite de recursos por consulta y puede estar incompleta. '
  + 'Intenta dividir la consulta en partes.';

function parseCorsAllowedOrigins(value) {
  if (value === undefined || value.trim() === '') {
    return [];
  }

  let origins;
  try {
    origins = JSON.parse(value);
  } catch (error) {
    throw new Error('CORS_ALLOWED_ORIGINS must be a JSON array of exact browser origins', { cause: error });
  }

  if (!Array.isArray(origins) || origins.some((origin) => typeof origin !== 'string')) {
    throw new TypeError('CORS_ALLOWED_ORIGINS must be a JSON array of exact browser origins');
  }

  for (const origin of origins) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(origin);
    } catch (error) {
      throw new TypeError(`Invalid origin in CORS_ALLOWED_ORIGINS: ${origin}`, { cause: error });
    }

    if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
      throw new TypeError(`Invalid origin in CORS_ALLOWED_ORIGINS: ${origin}`);
    }
  }

  return origins;
}

function getBearerToken(header) {
  if (typeof header !== 'string') {
    return null;
  }

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function isAuthenticationError(error) {
  return error?.status === 401
    || error?.code === 'PGRST301'
    || error?.code === '401'
    || /jwt.*(expired|invalid)|token.*(expired|invalid)|invalid.*jwt/i.test(error?.message ?? '');
}

function getTableStatus({ data, error }) {
  if (error) {
    return { status: 'error', readable: false };
  }

  return {
    status: data?.length ? 'ok' : 'empty',
    readable: true,
  };
}

function createRequestSupabaseClient(url, anonKey, accessToken) {
  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}

export function createApp({
  aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
  supabaseUrl = process.env.SUPABASE_URL,
  supabaseAnonKey = process.env.SUPABASE_ANON_KEY,
  corsAllowedOrigins = parseCorsAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS),
} = {}) {
  const app = express();

  app.use(cors({
    origin: (origin, callback) => callback(null, Boolean(origin && corsAllowedOrigins.includes(origin))),
  }));
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.status(200).json({
      success: true,
      message: '¡La API de Wavecore está activa y funcionando!',
      endpointChat: '/api/chat',
    });
  });

  app.post('/api/chat', async (req, res) => {
    const accessToken = getBearerToken(req.get('authorization'));
    if (!accessToken) {
      return res.status(401).json({
        success: false,
        error: 'Se requiere una sesión válida para consultar los datos de la empresa',
      });
    }

    if (!req.body?.message || typeof req.body.message !== 'string' || !req.body.message.trim()) {
      return res.status(400).json({ error: 'Falta el campo message en el body' });
    }

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('Supabase URL or public anon key is not configured');
      return res.status(500).json({
        success: false,
        error: 'La configuración de acceso a datos no está disponible',
      });
    }

    let geminiFailed = false;
    try {
      const supabase = createRequestSupabaseClient(supabaseUrl, supabaseAnonKey, accessToken);
      const businessResults = await Promise.all(CORPORATE_TABLES.map((table) => (
        supabase.from(table).select('*')
      )));
      const [zTestResult, chatLogsResult] = await Promise.all([
        supabase.from('z_test').select('*').limit(1),
        supabase.from('chat_logs').select('*').limit(1),
      ]);

      const businessErrors = businessResults.filter((result) => result.error);
      if (businessErrors.some((result) => isAuthenticationError(result.error))) {
        return res.status(401).json({
          success: false,
          error: 'La sesión no es válida o ha caducado. Inicia sesión de nuevo.',
        });
      }
      if (businessErrors.length) {
        console.error('Failed to read corporate data under the current RLS session', {
          tables: businessResults.flatMap((result, index) => result.error ? [{
            table: CORPORATE_TABLES[index],
            code: result.error.code,
          }] : []),
        });
        return res.status(502).json({
          success: false,
          error: 'No se pudieron consultar los datos de la empresa',
        });
      }

      const corporateContext = Object.fromEntries(
        CORPORATE_TABLES.map((table, index) => [table, businessResults[index].data ?? []]),
      );
      const tableStatus = Object.fromEntries(
        CORPORATE_TABLES.map((table, index) => [table, getTableStatus(businessResults[index])]),
      );
      const emptyTables = CORPORATE_TABLES.filter((table) => tableStatus[table].status === 'empty');
      if (emptyTables.length) {
        console.warn('Tablas sin filas visibles para esta sesión (¿RLS?):', emptyTables);
      }
      tableStatus.z_test = getTableStatus(zTestResult);
      tableStatus.chat_logs = getTableStatus(chatLogsResult);

      const selectedModel = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
      const apiVersion = 'v1.1';
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Desconocida';
      const systemPrompt = `
Eres un asistente virtual corporativo integral de la empresa. Tienes acceso a los datos de la compañía permitidos para esta sesión, en formato JSON:
${JSON.stringify(corporateContext, null, 2)}

Instrucciones:
- Responde a la pregunta del usuario basándote exclusivamente en la información corporativa anterior.
- Puedes cruzar o relacionar datos entre tablas si la pregunta lo requiere.
- Si te preguntan sobre temas ajenos a la empresa, recházalo educadamente indicando que solo atiendes consultas corporativas autorizadas.
      `;

      const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';
      const modelsToTry = [selectedModel, selectedModel, fallbackModel];
      let response;
      let selectedModelUsed = selectedModel;
      for (let attempt = 0; attempt < modelsToTry.length; attempt++) {
        selectedModelUsed = modelsToTry[attempt];
        try {
          response = await aiClient.models.generateContent({
            model: selectedModelUsed,
            contents: `${systemPrompt}\n\nPregunta del usuario: ${req.body.message.trim()}`,
            config: {
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              temperature: 0.2,
            },
          });
          break;
        } catch (aiError) {
          const retryable = aiError?.status === 503 || aiError?.status === 429;
          if (!retryable || attempt === modelsToTry.length - 1) {
            geminiFailed = true;
            throw aiError;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }

      const usage = response.usageMetadata || {};
      const outputLimitReached = response.candidates?.some(
        (candidate) => candidate.finishReason === 'MAX_TOKENS',
      ) ?? false;
      const generatedReply = response.text ?? '';
      const replyWithWarning = outputLimitReached
        ? `${generatedReply}${generatedReply ? '\n\n' : ''}${OUTPUT_LIMIT_WARNING}`
        : generatedReply;
      const fallbackUsed = selectedModelUsed !== selectedModel;
      const modelNote = fallbackUsed
        ? `Modelo utilizado: ${selectedModelUsed} (cambio automático desde ${selectedModel} por saturación del servicio)`
        : `Modelo utilizado: ${selectedModelUsed}`;
      const replyText = `${replyWithWarning}${replyWithWarning ? '\n\n' : ''}${modelNote}`;
      const tokenData = {
        promptTokens: usage.promptTokenCount || 0,
        responseTokens: usage.candidatesTokenCount || 0,
        totalTokens: usage.totalTokenCount || 0,
      };

      const { error: dbError } = await supabase.from('chat_logs').insert([{
        model_used: selectedModelUsed,
        prompt: req.body.message.trim(),
        reply: replyText,
        prompt_tokens: tokenData.promptTokens,
        response_tokens: tokenData.responseTokens,
        total_tokens: tokenData.totalTokens,
        client_ip: clientIp,
      }]);

      return res.status(200).json({
        success: true,
        apiVersion,
        clientIp,
        modelUsed: selectedModelUsed,
        fallbackUsed,
        reply: replyText,
        ...(outputLimitReached ? { warning: OUTPUT_LIMIT_WARNING } : {}),
        tokens: tokenData,
        tableStatus,
        databaseStatus: { saved: !dbError },
        receivedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error al procesar la petición:', error);
      if (geminiFailed) {
        const isOverloaded = error?.status === 503 || error?.status === 429;
        return res.status(isOverloaded ? 503 : 502).json({
          success: false,
          apiVersion: 'v1.1',
          error: isOverloaded
            ? 'Gemini tiene el servicio sobresaturado. Inténtalo de nuevo en unos segundos.'
            : 'Gemini no pudo procesar la consulta. Inténtalo de nuevo más tarde.',
        });
      }
      return res.status(500).json({
        success: false,
        apiVersion: 'v1.1',
        error: 'Error interno al procesar la petición',
      });
    }
  });

  return app;
}

const currentFile = fileURLToPath(import.meta.url);
const app = createApp();

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`API corriendo en el puerto ${port}`);
  });
}

export default app;
