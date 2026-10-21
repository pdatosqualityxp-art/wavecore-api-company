import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import { createRequestSupabaseClient } from './infrastructure/supabase.js';
import { createChatController } from './controllers/chat.controller.js';
import { createChatService } from './services/chat.service.js';

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

export function createApp({
  aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
  supabaseUrl = process.env.SUPABASE_URL,
  supabaseAnonKey = process.env.SUPABASE_ANON_KEY,
  corsAllowedOrigins = parseCorsAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS),
  supabaseClientFactory = createRequestSupabaseClient,
} = {}) {
  const app = express();
  const chatService = createChatService({
    aiClient,
    supabaseUrl,
    supabaseAnonKey,
    supabaseClientFactory,
  });

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

  app.post('/api/chat', createChatController(chatService));

  return app;
}

export default createApp();
