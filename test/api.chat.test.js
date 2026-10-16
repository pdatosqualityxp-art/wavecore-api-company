import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import deployedApp, { createApp } from '../index.js';

const SUPABASE_URL = 'https://example.supabase.co';
const ANON_KEY = 'public-anon-key';
const ORIGINAL_FETCH = globalThis.fetch;
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

let server;
let baseUrl;
let aiClient;
let aiCalls;
let prompts;
let generationConfigs;
let generationModels;
let aiFinishReason;
let aiError;
let aiFailingModel;
let requests;
let tableResponses;
let supabaseFetch;
let originalConsoleError;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Vercel request handler', () => {
  it('serves the health route through the default export', async () => {
    const server = deployedApp.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
      const response = await ORIGINAL_FETCH(`http://127.0.0.1:${server.address().port}/`);
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.endpointChat, '/api/chat');
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

async function postChat({ token = 'guest-session-token', message = 'Pregunta' } = {}) {
  return ORIGINAL_FETCH(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ message }),
  });
}

describe('POST /api/chat authentication and RLS reads', () => {
  beforeEach(async () => {
    originalConsoleError = console.error;
    console.error = () => {};
    requests = [];
    tableResponses = new Map();
    aiCalls = 0;
    prompts = [];
    generationConfigs = [];
    generationModels = [];
    aiFinishReason = undefined;
    aiError = undefined;
    aiFailingModel = undefined;
    aiClient = {
      models: {
        generateContent: async (input) => {
          aiCalls += 1;
          prompts.push(input.contents);
          generationConfigs.push(input.config);
          generationModels.push(input.model);
          if (aiError && (!aiFailingModel || input.model === aiFailingModel)) throw aiError;
          return {
            text: 'Respuesta de prueba',
            usageMetadata: {},
            candidates: aiFinishReason ? [{ finishReason: aiFinishReason }] : [],
          };
        },
      },
    };
    supabaseFetch = async (input, init) => {
      const url = new URL(input);
      if (url.origin !== SUPABASE_URL) {
        return ORIGINAL_FETCH(input, init);
      }

      const table = url.pathname.split('/').pop();
      requests.push({
        table,
        apikey: new Headers(init?.headers).get('apikey'),
        authorization: new Headers(init?.headers).get('authorization'),
        method: init?.method ?? 'GET',
      });
      const configuredResponse = tableResponses.get(table);
      if (configuredResponse) {
        return jsonResponse(configuredResponse.body, configuredResponse.status);
      }
      return jsonResponse(table === 'clientes' ? [{ id: 'visible-to-session' }] : []);
    };
    globalThis.fetch = supabaseFetch;

    server = createApp({
      aiClient,
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: ANON_KEY,
    }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.error = originalConsoleError;
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      server = undefined;
    }
  });

  it('forwards each caller bearer and anon apikey to Supabase, preserving RLS read states', async () => {
    const response = await postChat({ token: 'anonymous-user-jwt' });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(requests.length, CORPORATE_TABLES.length + 3);
    assert.ok(requests.every((request) => request.apikey === ANON_KEY));
    assert.ok(requests.every((request) => request.authorization === 'Bearer anonymous-user-jwt'));
    assert.equal(payload.tableStatus.clientes.status, 'ok');
    assert.equal(payload.tableStatus.clientes.readable, true);
    assert.equal(payload.tableStatus.ventas.status, 'empty');
    assert.equal(payload.tableStatus.ventas.readable, true);
    assert.match(payload.reply, /Respuesta de prueba/);
    assert.match(payload.reply, /Modelo utilizado: gemini-3\.1-flash-lite$/);
    assert.equal(generationConfigs[0].maxOutputTokens, 2048);
    assert.match(prompts[0], /visible-to-session/);
    assert.doesNotMatch(prompts[0], /hidden-from-session/);
    assert.equal(generationModels[0], 'gemini-3.1-flash-lite');

    const secondResponse = await postChat({ token: 'another-user-jwt' });
    assert.equal(secondResponse.status, 200);
    assert.ok(requests.slice(CORPORATE_TABLES.length + 3).every(
      (request) => request.authorization === 'Bearer another-user-jwt',
    ));
  });

  it('rejects a missing bearer without querying Supabase', async () => {
    const response = await postChat({ token: null });
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.match(payload.error, /sesión válida/i);
    assert.equal(requests.length, 0);
  });

  it('reports an expired session as authentication failure, not empty tables', async () => {
    tableResponses.set('clientes', {
      status: 401,
      body: { code: 'PGRST301', message: 'JWT expired' },
    });

    const response = await postChat();
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.match(payload.error, /caducado/i);
    assert.equal(payload.tableStatus, undefined);
    assert.equal(aiCalls, 0);
  });

  it('does not convert a Supabase read error into empty corporate data', async () => {
    tableResponses.set('ventas', {
      status: 403,
      body: { code: '42501', message: 'permission denied' },
    });

    const response = await postChat();
    const payload = await response.json();

    assert.equal(response.status, 502);
    assert.match(payload.error, /no se pudieron consultar/i);
    assert.equal(payload.tableStatus, undefined);
  });

  it('warns when Gemini truncates a response at the output token limit', async () => {
    aiFinishReason = 'MAX_TOKENS';

    const response = await postChat();
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.match(payload.reply, /Respuesta de prueba/);
    assert.match(payload.reply, /límite de recursos por consulta/i);
    assert.match(payload.reply, /Modelo utilizado: gemini-3\.1-flash-lite$/);
    assert.match(payload.warning, /límite de recursos por consulta/i);
  });

  it('identifies Gemini overload when the service rejects requests', async () => {
    aiError = Object.assign(new Error('Too many requests'), { status: 429 });

    const response = await postChat();
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.match(payload.error, /Gemini.*sobresaturado/i);
    assert.equal(aiCalls, 3);
  });

  it('identifies non-overload Gemini failures in the error message', async () => {
    aiError = Object.assign(new Error('Invalid request'), { status: 400 });

    const response = await postChat();
    const payload = await response.json();

    assert.equal(response.status, 502);
    assert.match(payload.error, /Gemini no pudo procesar/i);
    assert.equal(aiCalls, 1);
  });

  it('reports the automatic switch to the fallback model when the primary is overloaded', async () => {
    const originalModel = process.env.GEMINI_MODEL;
    const originalFallback = process.env.GEMINI_FALLBACK_MODEL;
    process.env.GEMINI_MODEL = 'primary-model';
    process.env.GEMINI_FALLBACK_MODEL = 'backup-model';
    aiError = Object.assign(new Error('Overloaded'), { status: 503 });
    aiFailingModel = 'primary-model';

    try {
      const response = await postChat();
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(generationModels, ['primary-model', 'primary-model', 'backup-model']);
      assert.equal(payload.modelUsed, 'backup-model');
      assert.equal(payload.fallbackUsed, true);
      assert.match(
        payload.reply,
        /Modelo utilizado: backup-model \(cambio automático desde primary-model por saturación del servicio\)$/,
      );
    } finally {
      if (originalModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = originalModel;
      if (originalFallback === undefined) delete process.env.GEMINI_FALLBACK_MODEL;
      else process.env.GEMINI_FALLBACK_MODEL = originalFallback;
    }
  });

  it('uses the Gemini model configured in the environment', async () => {
    const originalModel = process.env.GEMINI_MODEL;
    process.env.GEMINI_MODEL = 'gemini-test-model';

    try {
      const response = await postChat();
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(generationModels[0], 'gemini-test-model');
      assert.equal(payload.modelUsed, 'gemini-test-model');
      assert.match(payload.reply, /Modelo utilizado: gemini-test-model$/);
    } finally {
      if (originalModel === undefined) {
        delete process.env.GEMINI_MODEL;
      } else {
        process.env.GEMINI_MODEL = originalModel;
      }
    }
  });
});
