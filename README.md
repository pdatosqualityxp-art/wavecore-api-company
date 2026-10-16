# wavecore-api-company

Browser CORS is denied unless `CORS_ALLOWED_ORIGINS` is set to a JSON array of exact origins. For local development and the production frontend, configure the same value in `.env` and the Vercel project environment:

```env
CORS_ALLOWED_ORIGINS=["https://wavecore-nu.vercel.app","http://localhost:5173"]
```

Use origins only (scheme, host, and optional port), without a path or trailing slash. Leave the variable unset or empty to deny browser CORS. CORS is a browser policy and does not replace API authentication.

`POST /api/chat` requires a Supabase access token:

```http
Authorization: Bearer <access_token>
Content-Type: application/json
```

The server creates a Supabase client for each request using `SUPABASE_ANON_KEY` as the public `apikey` and the caller's bearer token as `Authorization`. Database reads therefore run under the caller's RLS policies, including anonymous guest sessions. Do not configure or use a `service_role` key.

Requests without a bearer token receive HTTP 401. Expired/invalid Supabase tokens also receive HTTP 401; failures reading corporate tables return HTTP 502 instead of being represented as empty tables.

Chat responses allow up to 2048 generated tokens. If Gemini reports that it reached this limit, the response includes a warning in both `reply` and `warning` that the answer may be incomplete.

Gemini failures return an explicit error message; overload/rate-limit failures identify Gemini as temporarily oversaturated and return HTTP 503.

Configure the primary Gemini model with the `GEMINI_MODEL` environment variable. For example, add `GEMINI_MODEL=gemini-3.1-flash-lite` to `.env` locally or create the same variable in the production environment settings. If unset, the server uses `gemini-3.1-flash-lite`. Each successful chat reply ends with the model used to generate it.

If the primary model is overloaded (HTTP 503/429) after two attempts, the request switches to `GEMINI_FALLBACK_MODEL` (default `gemini-2.5-flash`). In that case the reply footer states the automatic switch and the response includes `fallbackUsed: true`.

Run the backend request/RLS-header tests with `npm test`. The tests use mocked PostgREST responses and do not require live credentials.
