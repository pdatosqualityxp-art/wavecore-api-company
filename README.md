# wavecore-api-company

## Descripción general

**WaveCore** es una plataforma full stack con IA generativa para analítica empresarial y RAG documental. Este repositorio contiene su **API backend** (`wavecore-api-company`): un servicio Express que recibe preguntas en lenguaje natural, lee los datos corporativos permitidos para la sesión del usuario en Supabase y genera la respuesta con Gemini.

Cada consulta se ejecuta con la sesión del propio usuario, de modo que solo se utilizan los datos que sus políticas de seguridad a nivel de fila (RLS) permiten ver.

## Stack tecnológico

- **Node.js** (ES Modules). Se recomienda Node.js 22 o superior, requerido por `@supabase/supabase-js`.
- **Express 4** como framework HTTP y **cors** para la política de orígenes del navegador.
- **Supabase** (`@supabase/supabase-js`) para base de datos y autenticación, con RLS.
- **Google Gemini** (`@google/genai`) como modelo de IA generativa.
- **dotenv** para la configuración local.
- **node:test** (`node --test`) para las pruebas.
- **Vercel** (`@vercel/node`) para el despliegue.

## Instalación

1. Instala las dependencias:

   ```bash
   npm install
   ```

2. Crea un archivo `.env` en la raíz a partir de [.env.example](./.env.example):

   ```env
   SUPABASE_URL=https://tu-proyecto.supabase.co
   SUPABASE_ANON_KEY=tu_clave_anon_publica
   GEMINI_API_KEY=tu_clave_de_gemini
   GEMINI_MODEL=gemini-3.1-flash-lite
   GEMINI_FALLBACK_MODEL=gemini-2.5-flash
   CORS_ALLOWED_ORIGINS=["https://wavecore-nu.vercel.app","http://localhost:5173"]
   ```

   | Variable | Obligatoria | Descripción |
   |---|---|---|
   | `SUPABASE_URL` | Sí | URL del proyecto Supabase. |
   | `SUPABASE_ANON_KEY` | Sí | Clave pública `anon`. No uses una clave `service_role`. |
   | `GEMINI_API_KEY` | Sí | Clave de la API de Gemini. |
   | `GEMINI_MODEL` | No | Modelo principal. Por defecto `gemini-3.1-flash-lite`. |
   | `GEMINI_FALLBACK_MODEL` | No | Modelo de respaldo. Por defecto `gemini-2.5-flash`. |
   | `CORS_ALLOWED_ORIGINS` | No | Array JSON de orígenes exactos permitidos. Si no se define, se deniega CORS de navegador. |
   | `PORT` | No | Puerto local. Por defecto `3000`. |

   Los orígenes de `CORS_ALLOWED_ORIGINS` deben ser solo esquema, host y puerto opcional, sin ruta ni barra final. En Vercel, configura las mismas variables en el proyecto.

## Ejecución

```bash
npm start      # arranca el servidor (src/index.js)
npm run dev    # arranca con recarga automática
npm test       # ejecuta las pruebas
```

Comprueba que está activo con `GET http://localhost:3000/`. Para consultar el chat necesitas un token de acceso de Supabase:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Authorization: Bearer TU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"¿Qué clientes tengo?"}'
```

Las pruebas usan respuestas simuladas de PostgREST y Gemini, por lo que no requieren credenciales reales.

### Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | Comprobación de estado. |
| `POST` | `/api/chat` | Consulta en lenguaje natural. Requiere `Authorization: Bearer <token>` y un body `{ "message": "..." }`. |

## Estructura del proyecto

```text
.
├── index.js                      # Adaptador para Vercel: reexporta la app y createApp
├── vercel.json                   # Configuración de despliegue en Vercel
├── src/
│   ├── index.js                  # Arranque del servidor local (listen)
│   ├── app.js                    # Express, middlewares, CORS y rutas (createApp)
│   ├── controllers/
│   │   └── chat.controller.js    # Valida la petición HTTP y construye la respuesta
│   ├── services/
│   │   └── chat.service.js       # Consulta de datos, Gemini, reintentos y registro
│   └── infrastructure/
│       └── supabase.js           # Cliente de Supabase por petición con el token del usuario
└── test/
    └── api.chat.test.js          # Pruebas de la API
```

`createApp` acepta dependencias inyectables (`aiClient`, `supabaseUrl`, `supabaseAnonKey`, `corsAllowedOrigins`, `supabaseClientFactory`), lo que facilita las pruebas.

## Funcionalidades especiales

- **Seguridad con RLS:** el servidor crea un cliente de Supabase por petición con `SUPABASE_ANON_KEY` como `apikey` y el token del usuario como `Authorization`. Las lecturas se rigen por las políticas RLS del usuario, incluidas las sesiones anónimas. Nunca uses una clave `service_role`.
- **Autenticación:** sin token Bearer, o con un token caducado o inválido, se devuelve HTTP 401. Un fallo al leer las tablas corporativas devuelve HTTP 502, en lugar de presentarse como tablas vacías.
- **Estado por tabla:** la respuesta incluye `tableStatus`, que indica si cada tabla es legible y si tiene filas visibles para la sesión.
- **Contexto corporativo:** el asistente responde basándose exclusivamente en los datos corporativos accesibles para la sesión y rechaza temas ajenos a la empresa.
- **Reintentos y modelo de respaldo:** si el modelo principal está saturado (HTTP 503/429), se reintenta una vez y después se cambia a `GEMINI_FALLBACK_MODEL`. La respuesta indica `fallbackUsed: true` y el pie del texto detalla el cambio.
- **Límite de salida:** las respuestas admiten hasta 2048 tokens. Si Gemini alcanza el límite, se añade un aviso en `reply` y en `warning`.
- **Errores de Gemini explícitos:** la saturación devuelve HTTP 503 con un mensaje específico; otros fallos devuelven HTTP 502.
- **Registro de consultas:** cada respuesta se guarda en la tabla `chat_logs` (modelo, prompt, respuesta, tokens e IP del cliente), y `databaseStatus.saved` indica si se guardó.
- **CORS restrictivo:** solo se permiten los orígenes configurados; CORS no sustituye a la autenticación de la API.
