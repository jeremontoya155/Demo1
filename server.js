require('dotenv').config();
const express = require('express');
const { IgApiClient } = require('instagram-private-api');
const bodyParser = require('body-parser');
const path = require('path');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const uuid = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración MongoDB
const MONGO_URI = 'mongodb://mongo:lQZVSODFgPGsceBNsiqMULsokyBTpvUx@junction.proxy.rlwy.net:42830';
const DB_NAME = 'instagram_bot';
const COLLECTION_NAME = 'nicho_detectado';

// Configuración Express
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));

// Conexión a MongoDB
let db, mongoClient;
async function connectDB() {
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    console.log('Conectado a MongoDB');
  } catch (err) {
    console.error('Error de conexión a MongoDB:', err);
  }
}
connectDB();

// Ruta principal
app.get('/', async (req, res) => {
  try {
    // Obtener keywords únicas para el filtro
    const keywords = db ? await db.collection(COLLECTION_NAME)
      .distinct('keyword', { usado: { $ne: true } }) : [];
    
    res.render('index', { 
      defaultMessage: "¡Hola! ¿Estás disponible para una conversación rápida?",
      defaultMessagesVariations: `¡Hola! ¿Cómo estás?\nHola, ¿tienes un momento?\nBuen día, ¿podemos hablar?`,
      keywords: keywords || []
    });
  } catch (err) {
    console.error('Error al cargar keywords:', err);
    res.render('index', { 
      defaultMessage: "¡Hola! ¿Estás disponible para una conversación rápida?",
      defaultMessagesVariations: `¡Hola! ¿Cómo estás?\nHola, ¿tienes un momento?\nBuen día, ¿podemos hablar?`,
      keywords: [],
      error: 'Error al cargar keywords de la base de datos'
    });
  }
});

// Nueva ruta para obtener usuarios por keyword
app.post('/get-users', async (req, res) => {
  const { keyword } = req.body;
  
  try {
    if (!db) throw new Error('No hay conexión a MongoDB');
    
    const users = await db.collection(COLLECTION_NAME)
      .find({ 
        keyword,
        usado: { $ne: true } 
      })
      .project({ 
        perfil: 1, 
        username: 1, 
        fullname: 1, 
        keyword: 1,
        accion: 1,
        fecha: 1,
        _id: 1  // Puedes mantener esto si lo necesitas para referencia
      })
      .limit(20)
      .toArray();

    res.json({ success: true, users });
  } catch (err) {
    console.error('Error al obtener usuarios:', err);
    res.json({ success: false, error: err.message });
  }
});

// Función para marcar usuarios como usados
async function markAsUsed(usernames) {
  try {
    if (!db || !usernames || usernames.length === 0) return;
    
    await db.collection(COLLECTION_NAME)
      .updateMany(
        { perfil: { $in: usernames } },
        { $set: { usado: true, fecha_uso: new Date() } }
      );
    console.log(`Marcados ${usernames.length} usuarios como usados`);
  } catch (err) {
    console.error('Error al marcar como usados:', err);
  }
}

// Función para obtener mensaje aleatorio
function getRandomMessage(messagesText) {
  const variations = messagesText.split('\n')
    .map(msg => msg.trim())
    .filter(msg => msg.length > 0);
  
  if (variations.length === 0) return null;
  return variations[Math.floor(Math.random() * variations.length)];
}

// Middleware de verificación de sesión
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
  
  // Validación reforzada
  if (!sessionid?.trim() || !users?.trim()) {
    return res.status(400).render('results', {
      error: 'SessionID y lista de usuarios son requeridos',
      results: [],
      username: null,
      messageSent: null
    });
  }

  const targetAccounts = users.split('\n')
    .map(user => user.trim().replace('@', ''))
    .filter(user => user.length > 0 && user !== '');

  if (targetAccounts.length === 0 || targetAccounts.length > 50) {
    return res.status(400).render('results', {
      error: 'Debes ingresar entre 1 y 50 cuentas válidas',
      results: [],
      username: null,
      messageSent: null
    });
  }

  // Validación de mensajes
  const hasVariations = messages_variations?.trim().length > 0;
  const hasSingleMessage = message?.trim().length > 0;
  
  if (!hasVariations && !hasSingleMessage) {
    return res.status(400).render('results', {
      error: 'Debes ingresar un mensaje o variaciones',
      results: [],
      username: null,
      messageSent: null
    });
  }

const ig = new IgApiClient();
const results = [];
let currentUser = null;
let sessionValid = true;

try {
  ig.state.generateDevice('direct-sender');

  await ig.state.deserializeCookieJar(JSON.stringify({
    cookies: [{
      key: 'sessionid',
      value: sessionid,
      domain: 'instagram.com',
      path: '/',
      secure: true,
      httpOnly: true
    }]
  }));

  currentUser = await ig.account.currentUser(); // validación real


    
    // Procesamiento estable de mensajes
    const messageVariations = hasVariations 
      ? messages_variations.split('\n').map(m => m.trim()).filter(m => m)
      : [message.trim()];

    // Validación final de mensajes
    if (messageVariations.length === 0) {
      throw new Error('No hay mensajes válidos para enviar');
    }

    // Bucle de envío con gestión de errores por usuario
    for (const [index, user] of targetAccounts.entries()) {
      if (!sessionValid) break;
      
      try {
        // Verificación periódica de sesión
        if (index % 3 === 0) {
          sessionValid = await verifySession(ig);
          if (!sessionValid) throw new Error('Sesión expirada o inválida');
        }

        const userId = await ig.user.getIdByUsername(user);
        const finalMessage = messageVariations[Math.floor(Math.random() * messageVariations.length)];
        
        // Envío con reintento
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
            await new Promise(resolve => setTimeout(resolve, 30000));
          }
        }

        // Delay adaptativo mejorado
        const baseDelay = 90000 + (Math.random() * 30000);
        const progressiveDelay = index * 45000;
        const totalDelay = Math.min(baseDelay + progressiveDelay, 300000); // Máximo 5 minutos
        
        console.log(`[${new Date().toISOString()}] Enviado a ${user}. Esperando ${Math.round(totalDelay/1000)} segundos...`);
        await new Promise(resolve => setTimeout(resolve, totalDelay));

      } catch (error) {
        const errorMessage = error.message.includes('cookies') 
          ? 'Error de autenticación' 
          : error.message.includes('not found') 
          ? 'Usuario no encontrado' 
          : error.message;

        results.push({
          user,
          status: 'error',
          message: errorMessage,
          sentMessage: ''
        });

        // Espera de seguridad inteligente
        const retryDelay = error.message.includes('rate limit') ? 300000 : 60000;
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        
        // Verificar estado de sesión después de errores
        sessionValid = await verifySession(ig);
      }
    }

    // Marcar como usados solo los exitosos
    const successUsers = results.filter(r => r.status === 'success').map(r => r.user);
    if (successUsers.length > 0) {
      await markAsUsed(successUsers);
    }

  } catch (mainError) {
    console.error('[ERROR CRÍTICO]', mainError);
    results.push({
      user: 'Todos',
      status: 'error',
      message: mainError.message.includes('login') 
        ? 'SessionID inválido o expirado' 
        : mainError.message,
      sentMessage: ''
    });
  }

  // Renderizado final seguro
  res.render('results', {
    error: !sessionValid ? 'La sesión se interrumpió durante el proceso' : null,
    results: results.filter(r => r), // Filtra resultados nulos
    username: currentUser?.username || 'Desconocido',
    messageSent: hasVariations ? 'Variaciones de mensaje' : message
  });
});

// Cerrar conexión MongoDB al apagar el servidor
process.on('SIGINT', async () => {
  if (mongoClient) {
    await mongoClient.close();
    console.log('Conexión a MongoDB cerrada');
  }
  process.exit();
});

app.listen(PORT, () => {
  console.log(`Servidor estable corriendo en http://localhost:${PORT}`);
  if (!fs.existsSync('sessions')) {
    fs.mkdirSync('sessions');
  }
});