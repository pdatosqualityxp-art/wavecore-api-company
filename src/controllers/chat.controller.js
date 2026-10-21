import { ChatServiceError } from '../services/chat.service.js';

function getBearerToken(header) {
  if (typeof header !== 'string') {
    return null;
  }

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function createChatController(chatService) {
  return async (req, res) => {
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

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Desconocida';
    try {
      const result = await chatService({
        accessToken,
        message: req.body.message.trim(),
        clientIp,
      });
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof ChatServiceError) {
        return res.status(error.status).json(error.body);
      }

      console.error('Error al procesar la petición:', error);
      return res.status(500).json({
        success: false,
        apiVersion: 'v1.1',
        error: 'Error interno al procesar la petición',
      });
    }
  };
}
