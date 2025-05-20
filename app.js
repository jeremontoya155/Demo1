require('dotenv').config();
const express = require('express');
const { IgApiClient } = require('instagram-private-api');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const uuid = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));

// Ruta principal
app.get('/', (req, res) => {
  res.render('index', { 
    defaultMessage: "¡Hola! ¿Estás disponible para una conversación rápida?",
    defaultMessagesVariations: `Variación 1: ¡Hola! ¿Cómo estás?\nVariación 2: Hola, ¿tienes un momento?\nVariación 3: Buen día, ¿podemos hablar?`
  });
});

// Función para obtener un mensaje aleatorio
function getRandomMessage(messagesText) {
  const variations = messagesText.split('\n')
    .map(msg => msg.trim())
    .filter(msg => msg.length > 0 && msg.includes('Variación'));
  
  if (variations.length === 0) return messagesText.split('\n')[0] || messagesText;
  
  const randomIndex = Math.floor(Math.random() * variations.length);
  return variations[randomIndex].replace(/^Variación \d+: /, '');
}

// Función de verificación de sesión
async function verifySession(ig) {
  try {
    await ig.account.currentUser();
    return true;
  } catch (error) {
    return false;
  }
}

// Ruta para enviar mensajes
app.post('/send', async (req, res) => {
  const { sessionid, users, message, messages_variations } = req.body;
  
  // Validaciones
  if (!sessionid || !users || (!message && !messages_variations)) {
    return res.status(400).render('results', {
      error: 'Faltan campos requeridos',
      results: [],
      username: null,
      messageSent: null
    });
  }

  const targetAccounts = users.split('\n')
    .map(user => user.trim().replace('@', ''))
    .filter(user => user.length > 0);

  if (targetAccounts.length === 0 || targetAccounts.length > 50) {
    return res.status(400).render('results', {
      error: 'Debes ingresar entre 1 y 50 cuentas',
      results: [],
      username: null,
      messageSent: null
    });
  }

  const ig = new IgApiClient();
  let currentUser = null;
  const results = [];
  let sessionValid = true;

  try {
    // Configurar sesión
    ig.state.generateDevice(sessionid);
    await ig.state.deserializeCookieJar(JSON.stringify({
      cookies: [{
        key: 'sessionid',
        value: sessionid,
        domain: 'instagram.com',
        secure: true,
        path: '/'
      }]
    }));

    // Verificar sesión inicial
    currentUser = await ig.account.currentUser();
    if (!currentUser) throw new Error('Sesión inválida');

    // Procesar cada cuenta con persistencia
    for (const [index, user] of targetAccounts.entries()) {
      if (!sessionValid) break;
      
      try {
        // Verificación periódica de sesión
        if (index % 5 === 0) {
          sessionValid = await verifySession(ig);
          if (!sessionValid) throw new Error('Sesión expirada');
        }

        const userId = await ig.user.getIdByUsername(user);
        const finalMessage = messages_variations 
          ? getRandomMessage(messages_variations)
          : message.substring(0, 1000);

        // Envío persistente con reintento
        let attempts = 0;
        let success = false;
        
        while (attempts < 2 && !success) {
          try {
            await ig.entity.directThread([userId.toString()]).broadcastText(finalMessage);
            success = true;
            results.push({
              user,
              status: 'success',
              message: 'Mensaje enviado',
              sentMessage: finalMessage
            });
          } catch (sendError) {
            attempts++;
            if (attempts >= 2) throw sendError;
            
            // Esperar antes de reintentar
            await new Promise(resolve => setTimeout(resolve, 30000));
          }
        }

        // Delay adaptativo
        const baseDelay = 90000 + (Math.random() * 30000);
        const progressiveDelay = index * 45000;
        const totalDelay = baseDelay + progressiveDelay;
        
        console.log(`Enviado a ${user}. Esperando ${Math.round(totalDelay/1000)} segundos...`);
        await new Promise(resolve => setTimeout(resolve, totalDelay));

      } catch (error) {
        sessionValid = false;
        const errorMsg = error.message.includes('cookies') 
          ? 'Error de autenticación' 
          : error.message;
        
        results.push({
          user,
          status: 'error',
          message: errorMsg,
          sentMessage: ''
        });

        // Espera de seguridad antes de continuar
        await new Promise(resolve => setTimeout(resolve, 120000));
      }
    }

  } catch (mainError) {
    console.error('Error general:', mainError);
    results.push({
      user: 'Todos',
      status: 'error',
      message: mainError.message,
      sentMessage: ''
    });
  }

  // Renderizar resultados
  res.render('results', {
    error: !sessionValid ? 'La sesión se perdió durante el proceso' : null,
    results,
    username: currentUser?.username || 'Desconocido',
    messageSent: message
  });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  if (!fs.existsSync('sessions')) {
    fs.mkdirSync('sessions');
  }
});