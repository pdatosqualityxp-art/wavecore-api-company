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

export class ChatServiceError extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
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

export function createChatService({
  aiClient,
  supabaseUrl,
  supabaseAnonKey,
  supabaseClientFactory,
}) {
  return async ({ accessToken, message, clientIp }) => {
    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('Supabase URL or public anon key is not configured');
      throw new ChatServiceError(500, {
        success: false,
        error: 'La configuración de acceso a datos no está disponible',
      });
    }

    let geminiFailed = false;
    try {
      const supabase = supabaseClientFactory(supabaseUrl, supabaseAnonKey, accessToken);
      const businessResults = await Promise.all(CORPORATE_TABLES.map((table) => (
        supabase.from(table).select('*')
      )));
      const [zTestResult, chatLogsResult] = await Promise.all([
        supabase.from('z_test').select('*').limit(1),
        supabase.from('chat_logs').select('*').limit(1),
      ]);

      const businessErrors = businessResults.filter((result) => result.error);
      if (businessErrors.some((result) => isAuthenticationError(result.error))) {
        throw new ChatServiceError(401, {
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
        throw new ChatServiceError(502, {
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
            contents: `${systemPrompt}\n\nPregunta del usuario: ${message}`,
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
        prompt: message,
        reply: replyText,
        prompt_tokens: tokenData.promptTokens,
        response_tokens: tokenData.responseTokens,
        total_tokens: tokenData.totalTokens,
        client_ip: clientIp,
      }]);

      return {
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
      };
    } catch (error) {
      if (error instanceof ChatServiceError) {
        throw error;
      }

      console.error('Error al procesar la petición:', error);
      if (geminiFailed) {
        const isOverloaded = error?.status === 503 || error?.status === 429;
        throw new ChatServiceError(isOverloaded ? 503 : 502, {
          success: false,
          apiVersion: 'v1.1',
          error: isOverloaded
            ? 'Gemini tiene el servicio sobresaturado. Inténtalo de nuevo en unos segundos.'
            : 'Gemini no pudo procesar la consulta. Inténtalo de nuevo más tarde.',
        });
      }

      throw new ChatServiceError(500, {
        success: false,
        apiVersion: 'v1.1',
        error: 'Error interno al procesar la petición',
      });
    }
  };
}
