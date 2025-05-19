require('dotenv').config();
const express = require('express');
const { IgApiClient } = require('instagram-private-api');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const uuid = require('uuid');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY 
});

// Configuración de Express
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));

// Middleware para crear directorio de sesiones
app.use((req, res, next) => {
  if (!fs.existsSync('sessions')) {
    fs.mkdirSync('sessions');
  }
  next();
});

// Ruta principal
app.get('/', (req, res) => {
  res.render('index', { 
    defaultMessage: "¡Hola {target}! ¿Estás disponible para una conversación rápida?",
    defaultMessagesVariations: `Variación 1: ¡Hola {target}! ¿Cómo estás?\nVariación 2: Hola {target}, ¿tienes un momento?\nVariación 3: Buen día {target}, ¿podemos hablar?`,
    templates: [
      {name: "Invitación simple", value: "¡Hola {target}! Me encantaría conectar contigo."},
      {name: "Interés común", value: "Hola {target}, vi que te interesa {topic} y quería saber más."},
      {name: "Colaboración", value: "¡Hola {target}! ¿Te interesaría colaborar en algo?"},
      {name: "Cumplido", value: "Hola {target}, quería decirte que me encanta tu contenido sobre {ai}"},
      {name: "Networking", value: "¡Hola {target}! Estamos en la misma industria y me gustaría conectarme {ai}"}
    ]
  });
});

// Función para obtener mensaje aleatorio
function getRandomMessage(messagesText) {
  const variations = messagesText.split('\n')
    .map(msg => msg.trim())
    .filter(msg => msg.length > 0 && (msg.includes('Variación') || msg.includes('Variacion')));
  
  if (variations.length === 0) return messagesText.split('\n')[0] || messagesText;
  
  const randomIndex = Math.floor(Math.random() * variations.length);
  return variations[randomIndex].replace(/^Variaci[óo]n \d+: /, '');
}

// Función para personalizar mensajes
async function personalizeMessage(template, targetUsername, senderUsername, customContext = "") {
  try {
    // Reemplazo básico de variables
    let message = template
      .replace(/{target}/g, `@${targetUsername}`)
      .replace(/{username}/g, senderUsername)
      .replace(/{topic}/g, customContext || 'este tema');

    // Si necesita generación por IA
    if (message.includes('{ai}')) {
      const prompt = `Escribe un mensaje personalizado para @${targetUsername} de parte de ${senderUsername}. 
      Contexto: ${customContext || 'Quiero iniciar una conversación'}. 
      El mensaje debe ser natural para Instagram Directo, máximo 2 frases. 
      Base: ${message.replace('{ai}', '')}`;
      
      const completion = await openai.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "gpt-3.5-turbo",
        max_tokens: 100,
        temperature: 0.7
      });
      
      message = completion.choices[0].message.content;
    }
    
    return message;
  } catch (error) {
    console.error("Error al personalizar mensaje:", error);
    // Fallback seguro
    return template.replace(/{target}/g, `@${targetUsername}`)
                   .replace(/{username}/g, senderUsername)
                   .replace(/{ai}/g, '')
                   .replace(/{topic}/g, customContext || 'este tema');
  }
}

// Ruta para enviar mensajes
app.post('/send', async (req, res) => {
  const { sessionid, users, message, messages_variations, custom_context } = req.body;
  
  // Validaciones
  if (!sessionid || !users) {
    return res.status(400).render('error', { error: 'Faltan campos requeridos: Session ID y/o usuarios' });
  }

  const targetAccounts = users.split('\n')
    .map(user => user.trim().replace('@', ''))
    .filter(user => user.length > 0 && !user.startsWith('http'));

  if (targetAccounts.length === 0 || targetAccounts.length > 50) {
    return res.status(400).render('error', { error: 'Debes ingresar entre 1 y 50 cuentas válidas' });
  }

  const ig = new IgApiClient();
  const sessionFile = `sessions/session_${uuid.v4()}.json`;

  try {
    // Configurar Instagram
    ig.state.generateDevice(sessionid);
    ig.state.proxyUrl = process.env.IG_PROXY;
    await ig.state.deserializeCookieJar(JSON.stringify({
      cookies: [{ 
        key: 'sessionid', 
        value: sessionid, 
        domain: 'instagram.com', 
        secure: true, 
        path: '/' 
      }]
    }));

    // Verificar sesión
    const currentUser = await ig.account.currentUser();
    const results = [];
    let successfulSends = 0;

    for (const [index, targetUser] of targetAccounts.entries()) {
      try {
        const userId = await ig.user.getIdByUsername(targetUser);
        
        // Seleccionar y personalizar mensaje
        const messageTemplate = messages_variations ? 
          getRandomMessage(messages_variations) : 
          message;
        
        const personalizedMessage = await personalizeMessage(
          messageTemplate, 
          targetUser, 
          currentUser.username,
          custom_context
        );
        
        // Enviar mensaje
        await ig.entity.directThread([userId]).broadcastText(personalizedMessage);
        successfulSends++;
        
        results.push({ 
          user: targetUser, 
          status: 'success', 
          message: 'Mensaje enviado',
          sentMessage: personalizedMessage
        });
        
        // Delay inteligente basado en el índice y límites de Instagram
        const baseDelay = 60000; // 1 minuto base
        const progressiveDelay = index * 30000; // 30 segundos adicionales por cuenta
        const randomDelay = Math.random() * 60000; // hasta 1 minuto aleatorio
        const safetyDelay = successfulSends > 5 ? 120000 : 0; // 2 minutos extra después de 5 envíos
        
        const totalDelay = baseDelay + progressiveDelay + randomDelay + safetyDelay;
        
        console.log(`Enviado a @${targetUser}. Esperando ${Math.round(totalDelay/1000)} segundos...`);
        await new Promise(resolve => setTimeout(resolve, totalDelay));
        
      } catch (error) {
        console.error(`Error con @${targetUser}:`, error);
        results.push({ 
          user: targetUser, 
          status: 'error', 
          message: error.message.includes('wait a few minutes') ? 
            'Límite de Instagram - Espera unos minutos' : 
            error.message,
          sentMessage: ''
        });
        
        // Delay de seguridad en errores
        await new Promise(resolve => setTimeout(resolve, 180000)); // 3 minutos en errores
      }
    }

    res.render('results', { 
      username: currentUser.username,
      results,
      totalAccounts: targetAccounts.length,
      successfulSends,
      failedSends: targetAccounts.length - successfulSends
    });

  } catch (error) {
    console.error('Error general:', error);
    res.status(500).render('error', { 
      error: `Error al procesar la solicitud: ${error.message}`,
      solution: 'Verifica tu Session ID y conexión a Internet'
    });
  } finally {
    if (fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
    }
  }
});

// Ruta de error
app.get('/error', (req, res) => {
  res.render('error', { 
    error: 'Ocurrió un error desconocido',
    solution: 'Intenta nuevamente más tarde'
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});