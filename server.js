require('dotenv').config();
// DEBUG: mostrar variáveis de ambiente relevantes para diagnóstico de email
try {
    console.log('[env-debug] EMAIL_SERVICE=', process.env.EMAIL_SERVICE, ' EMAIL_USER=', process.env.EMAIL_USER, ' EMAIL_PASS_LEN=', process.env.EMAIL_PASS ? process.env.EMAIL_PASS.length : 0, ' SMTP_HOST=', process.env.SMTP_HOST);
} catch (e) {
    console.log('[env-debug] erro ao ler env:', e && e.message);
}
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const winston = require('winston');
const multer = require('multer');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { Server } = require("socket.io");

// Global handlers para capturar exceções não tratadas e promessas rejeitadas
process.on('uncaughtException', (err) => {
    try {
        console.error('uncaughtException:', err && (err.stack || err.message || err));
    } catch (e) {
        console.error('uncaughtException (falha ao logar):', e && e.message);
    }
});

process.on('unhandledRejection', (reason, p) => {
    try {
        console.error('unhandledRejection:', reason && (reason.stack || reason));
    } catch (e) {
        console.error('unhandledRejection (falha ao logar):', e && e.message);
    }
});

// --- Inicialização do Banco de Dados SQLite ---
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error('Erro ao conectar ao banco de dados:', err.message);
        process.exit(1);
    }
    console.log('Conectado ao banco de dados SQLite.');
    // Verifica se a coluna sent_via_whatsapp existe na tabela messages; se não existir, adiciona.
    db.all("PRAGMA table_info(messages)", (prErr, cols) => {
        if (prErr) {
            console.warn('Falha ao checar colunas de messages:', prErr.message || prErr);
            return;
        }
        const hasSentFlag = cols && cols.some(c => c.name === 'sent_via_whatsapp');
        const hasDeliveredFlag = cols && cols.some(c => c.name === 'delivered');
        const hasWaId = cols && cols.some(c => c.name === 'wa_message_id');
        if (!hasSentFlag) {
            try {
                db.run("ALTER TABLE messages ADD COLUMN sent_via_whatsapp INTEGER DEFAULT 0", (alterErr) => {
                    if (alterErr) logger.warn('Falha ao adicionar coluna sent_via_whatsapp:', alterErr.message || alterErr);
                    else logger.info('Coluna sent_via_whatsapp adicionada à tabela messages.');
                });
            } catch (e) {
                logger.warn('Erro ao executar ALTER TABLE messages:', e && e.message);
            }
        }
        if (!hasDeliveredFlag) {
            try {
                db.run("ALTER TABLE messages ADD COLUMN delivered INTEGER DEFAULT 0", (alterErr) => {
                    if (alterErr) logger.warn('Falha ao adicionar coluna delivered:', alterErr.message || alterErr);
                    else logger.info('Coluna delivered adicionada à tabela messages.');
                });
            } catch (e) {
                logger.warn('Erro ao executar ALTER TABLE messages (delivered):', e && e.message);
            }
        }
        if (!hasWaId) {
            try {
                db.run("ALTER TABLE messages ADD COLUMN wa_message_id TEXT DEFAULT NULL", (alterErr) => {
                    if (alterErr) logger.warn('Falha ao adicionar coluna wa_message_id:', alterErr.message || alterErr);
                    else logger.info('Coluna wa_message_id adicionada à tabela messages.');
                });
            } catch (e) {
                logger.warn('Erro ao executar ALTER TABLE messages (wa_message_id):', e && e.message);
            }
        }
    });
});

// --- Função auxiliar para obter data/hora no formato correto ---
function getLocalDateTime() {
    const now = new Date();
    // Retorna no formato local do sistema (YYYY-MM-DD HH:MM:SS)
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// --- Função auxiliar para formatar data/hora da última mensagem ---
function formatLastMessageTime(lastMessageAt) {
    if (!lastMessageAt) return '';

    const messageDate = new Date(lastMessageAt);
    const now = new Date();
    const diffInMs = now - messageDate;
    const diffInHours = diffInMs / (1000 * 60 * 60);
    const diffInDays = diffInMs / (1000 * 60 * 60 * 24);

    // Se for hoje (menos de 24 horas), mostrar apenas a hora
    if (diffInHours < 24) {
        return messageDate.toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    }

    // Se for ontem (entre 24-48 horas), mostrar "Ontem"
    if (diffInDays >= 1 && diffInDays < 2) {
        return 'Ontem';
    }

    // Se for mais antigo (mais de 48 horas), mostrar data completa
    return messageDate.toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
}

// Função para verificar se o horário atual está dentro do horário de funcionamento configurado
function isWithinBusinessHours(startTime, endTime) {
    // Se não houver horários configurados, considera que está sempre disponível
    if (!startTime || !endTime) {
        return true;
    }

    const now = new Date();
    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    
    // Converte os horários para minutos desde meia-noite para facilitar comparação
    const timeToMinutes = (timeStr) => {
        const [hours, minutes] = timeStr.split(':').map(Number);
        return hours * 60 + minutes;
    };
    
    const currentMinutes = timeToMinutes(currentTime);
    const startMinutes = timeToMinutes(startTime);
    const endMinutes = timeToMinutes(endTime);
    
    // Verifica se o horário de término é menor que o de início (atravessa meia-noite)
    if (endMinutes < startMinutes) {
        // Horário atravessa meia-noite (ex: 22:00 até 06:00)
        return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    } else {
        // Horário normal (ex: 08:00 até 18:00)
        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }
}

// Envia uma mensagem via WhatsApp somente se o ticket ainda NÃO estiver atribuído a um agente.
// Além disso, somente envia se a conexão associada tiver a flag `is_default` habilitada.
// Retorna uma Promise que resolve true se a mensagem foi enviada e salva, false caso contrário.
async function sendBotMessageIfUnassigned(clientInstance, contactId, ticketId, message) {
    return new Promise((resolve) => {
        db.get('SELECT user_id, is_manual FROM tickets WHERE id = ?', [ticketId], async (err, row) => {
            if (err) {
                logger.warn(`Erro ao verificar atribuição do ticket ${ticketId}: ${err.message}`);
                return resolve(false);
            }

            if (row && row.is_manual === 1) {
                logger.info(`Ticket ${ticketId} é manual; pulando envio de mensagem bot.`);
                return resolve(false);
            }

            if (row && row.user_id) {
                logger.info(`Ticket ${ticketId} já atribuído ao agente ${row.user_id}; pulando envio de mensagem bot.`);
                return resolve(false);
            }

            if (!clientInstance) {
                logger.warn(`Cliente WhatsApp não disponível; pulando envio de mensagem para ticket ${ticketId}`);
                return resolve(false);
            }

            // Tenta identificar a connection_id associada a este clientInstance via sessions
            let connId = null;
            try {
                for (const k of Object.keys(sessions)) {
                    if (sessions[k] === clientInstance) {
                        connId = parseInt(k, 10);
                        break;
                    }
                }
            } catch (mapErr) {
                // não fatal, apenas prossegue para tentar ler do ticket
            }

            const proceedWithCheck = async (connectionIdFromTicket) => {
                const usedConnId = connId || connectionIdFromTicket || null;

                if (usedConnId) {
                    // Verifica se a conexão tem is_default e chatbot_enabled habilitados
                    db.get('SELECT is_default, chatbot_enabled FROM connections WHERE id = ?', [usedConnId], async (cErr, cRow) => {
                        if (cErr) {
                            logger.warn(`Erro ao ler configuração da connection ${usedConnId}: ${cErr.message}`);
                            return resolve(false);
                        }

                        if (cRow && (cRow.is_default === 0 || cRow.is_default === '0' || cRow.is_default === null)) {
                            logger.info(`Connection ${usedConnId} tem is_default desabilitado; pulando envio de mensagem bot para ticket ${ticketId}`);
                            return resolve(false);
                        }

                        if (cRow && cRow.chatbot_enabled !== 1) {
                            logger.info(`Connection ${usedConnId} tem chatbot desabilitado; pulando envio de mensagem bot para ticket ${ticketId}`);
                            return resolve(false);
                        }

                        // Connection ok -> enviar
                        try {
                            const waMsg = await clientInstance.sendMessage(contactId, message);
                            const waId = waMsg && waMsg.id && waMsg.id._serialized ? waMsg.id._serialized : null;
                            const sentAt = getLocalDateTime();
                            db.run('INSERT INTO messages (ticket_id, body, sender, timestamp, sent_via_whatsapp, wa_message_id, delivered) VALUES (?, ?, ?, ?, ?, ?, ?)', [ticketId, message, 'bot', sentAt, 1, waId, 0], function(saveErr) {
                                if (saveErr) logger.warn(`Falha ao salvar mensagem bot para ticket ${ticketId}: ${saveErr.message}`);
                                else io.emit('new-message', { id: this.lastID, ticket_id: ticketId, body: message, sender: 'bot', timestamp: sentAt, sent_via_whatsapp: 1, wa_message_id: waId, delivered: 0 });
                                return resolve(true);
                            });
                        } catch (sendErr) {
                            logger.error(`Erro ao enviar mensagem via WhatsApp para ticket ${ticketId}: ${sendErr.message}`);
                            return resolve(false);
                        }
                    });
                } else {
                    // Não determinamos connection_id -> comportamento retrocompatível: envia
                    try {
                        const waMsg = await clientInstance.sendMessage(contactId, message);
                        const waId = waMsg && waMsg.id && waMsg.id._serialized ? waMsg.id._serialized : null;
                        const sentAt = getLocalDateTime();
                        db.run('INSERT INTO messages (ticket_id, body, sender, timestamp, sent_via_whatsapp, wa_message_id, delivered) VALUES (?, ?, ?, ?, ?, ?, ?)', [ticketId, message, 'bot', sentAt, 1, waId, 0], function(saveErr) {
                            if (saveErr) logger.warn(`Falha ao salvar mensagem bot para ticket ${ticketId}: ${saveErr.message}`);
                            else io.emit('new-message', { id: this.lastID, ticket_id: ticketId, body: message, sender: 'bot', timestamp: sentAt, sent_via_whatsapp: 1, wa_message_id: waId, delivered: 0 });
                            return resolve(true);
                        });
                    } catch (sendErr) {
                        logger.error(`Erro ao enviar mensagem via WhatsApp para ticket ${ticketId}: ${sendErr.message}`);
                        return resolve(false);
                    }
                }
            };

            // Se ainda não mapeamos via sessions, tenta ler connection_id do ticket
            if (!connId) {
                db.get('SELECT connection_id FROM tickets WHERE id = ?', [ticketId], (tErr, tRow) => {
                    if (tErr) {
                        logger.warn(`Erro ao buscar connection_id do ticket ${ticketId}: ${tErr.message}`);
                        return proceedWithCheck(null);
                    }
                    return proceedWithCheck(tRow && tRow.connection_id ? tRow.connection_id : null);
                });
            } else {
                proceedWithCheck(null);
            }
        });
    });
}

// --- Configuração do Logger (Winston) ---
const logDir = 'logs';
// Cria o diretório de logs se ele não existir
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(info => `${info.timestamp} ${info.level.toUpperCase()}: ${info.message}`)
  ),
  transports: [
    // Exibe logs no console com cores
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple())
    }),
    // Salva todos os logs no arquivo app.log
    new winston.transports.File({ filename: path.join(logDir, 'app.log') })
  ]
});

// --- Configuração do Email (Nodemailer) ---
// Recomendação: configure variáveis de ambiente em um arquivo .env
// Exemplos de variáveis esperadas (adicione ao seu .env):
// EMAIL_SERVICE=gmail
// EMAIL_USER=seu-email@gmail.com
// EMAIL_PASS=senha-de-app-ou-smtp
// ou, para SMTP customizado:
// SMTP_HOST=smtp.exemplo.com
// SMTP_PORT=587
// SMTP_SECURE=false

// Monta as opções do transporte a partir das variáveis de ambiente
let mailTransporter = null;
try {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined;
    const smtpSecure = process.env.SMTP_SECURE === 'true';

    let transportOptions;
    if (smtpHost) {
        // Configuração explícita de SMTP (ex: SendGrid, Mailgun, provedor próprio)
        transportOptions = {
            host: smtpHost,
            port: smtpPort || 587,
            secure: !!smtpSecure,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        };
    } else {
        // Fallback para provider simples (Gmail)
        transportOptions = {
            service: process.env.EMAIL_SERVICE || 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        };
    }

    if (!transportOptions.auth || !transportOptions.auth.user || !transportOptions.auth.pass) {
        // Se não houver credenciais explícitas, tentamos criar uma conta de teste Ethereal
        nodemailer.createTestAccount().then(testAccount => {
            const testTransport = {
                host: testAccount.smtp.host,
                port: testAccount.smtp.port,
                secure: testAccount.smtp.secure,
                auth: {
                    user: testAccount.user,
                    pass: testAccount.pass
                }
            };
            mailTransporter = nodemailer.createTransport(testTransport);
            mailTransporter.verify((err) => {
                if (err) {
                    logger.error('Falha ao verificar transporte de email de teste:', err);
                    mailTransporter = null;
                } else {
                    logger.info('Conta de email de teste criada (Ethereal). Emails serão capturados e ficarão acessíveis via preview URL.');
                    logger.info(`Ethereal user: ${testAccount.user}`);
                }
            });
        }).catch(err => {
            logger.warn('Credenciais de email não configuradas (EMAIL_USER / EMAIL_PASS ausentes) e falha ao criar conta de teste:', err);
            mailTransporter = null;
        });
    } else {
        mailTransporter = nodemailer.createTransport(transportOptions);

        // Verifica imediatamente as credenciais para reduzir erros em runtime
        mailTransporter.verify((err, success) => {
            if (err) {
                logger.error('Falha ao verificar transporte de email (credenciais inválidas ou bloqueio do provedor):', err);
                logger.error('Se estiver usando Gmail, ative 2FA e crie uma Senha de App (https://myaccount.google.com/apppasswords) ou configure OAuth2.');
                mailTransporter = null; // desabilita envio para evitar falhas recorrentes
            } else {
                logger.info('Configuração de email carregada e verificada com sucesso');
            }
        });
    }
} catch (error) {
    logger.error('Erro ao configurar email:', error);
    mailTransporter = null;
}

// Função para enviar email de verificação
async function sendVerificationEmail(email, name, token) {
    const verificationLink = `https://phticket.shop/verify-email?token=${token}`;
    
    const mailOptions = {
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'no-reply@localhost',
        to: email,
    subject: 'PHTicket - Confirme seu email',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #333;">Bem-vindo ao PHTicket, ${name}!</h2>
                <p>Obrigado por se registrar. Para ativar sua conta, clique no botão abaixo:</p>
                <div style="text-align: center; margin: 30px 0;">
                    <a href="${verificationLink}" 
                       style="background-color: #007bff; color: white; padding: 12px 30px; 
                              text-decoration: none; border-radius: 5px; display: inline-block;">
                        Confirmar Email
                    </a>
                </div>
                <p>Ou copie e cole este link no seu navegador:</p>
                <p style="word-break: break-all; color: #666;">${verificationLink}</p>
                <p style="color: #999; font-size: 12px; margin-top: 30px;">
                    Este link expira em 24 horas.<br>
                    Se você não criou esta conta, ignore este email.
                </p>
            </div>
        `
    };

    try {
        if (mailTransporter) {
            // Ensure envelope.from matches authenticated user to avoid provider rewriting/quotas
            if (!mailOptions.from || mailOptions.from === 'no-reply@localhost') {
                mailOptions.from = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'no-reply@localhost';
            }
            // Force envelope from to authenticated user when available
            const envelope = { from: process.env.EMAIL_USER || mailOptions.from, to: mailOptions.to };

            const info = await mailTransporter.sendMail({ ...mailOptions, envelope });

            logger.info(`Email de verificação enviado (messageId=${info.messageId}) para: ${email}`);
            if (info.accepted && info.accepted.length > 0) logger.info(`accepted: ${info.accepted.join(',')}`);
            if (info.rejected && info.rejected.length > 0) logger.warn(`rejected: ${info.rejected.join(',')}`);
            if (info.response) logger.debug(`smtp response: ${info.response}`);

            // If using Ethereal, log preview URL
            try {
                const preview = nodemailer.getTestMessageUrl(info);
                if (preview) logger.info(`Preview do email (Ethereal): ${preview}`);
            } catch (e) {
                // ignore
            }

            // If the provider returned rejections, suggest checking SPF/DKIM and sender address
            if (info.rejected && info.rejected.length > 0) {
                logger.warn('Alguns destinatários rejeitaram o email. Verifique se o remetente está autorizado (SPF/DKIM) e se o provedor bloqueou a mensagem.');
            }

            return true;
        } else {
            // Fallback: salvar o email em disco para desenvolvimento/inspeção
            try {
                const outDir = path.join(__dirname, 'logs', 'outgoing_emails');
                if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
                const fileName = `${Date.now()}-${email.replace(/[^a-z0-9@.]/gi, '_')}.html`;
                const filePath = path.join(outDir, fileName);
                const content = `To: ${email}\nSubject: PHTicket - Confirme seu email\n\n${mailOptions.html}`;
                fs.writeFileSync(filePath, content, { encoding: 'utf8' });
                logger.warn(`Transportador de email não configurado — email de verificação salvo em: ${filePath}`);
                return true; // consider as 'sent' for app flow
            } catch (fsErr) {
                logger.error('Falha ao salvar email em disco como fallback:', fsErr);
                return false;
            }
        }
    } catch (error) {
        logger.error(`Erro ao enviar email para ${email}:`, error);
        throw error;
    }
}

// --- Configuração do Multer para Upload de Arquivos ---
const uploadDir = path.join(__dirname, 'uploads');

// --- Função para gerar número de protocolo único ---
function generateProtocolNumber(ticketId) {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = String(now.getFullYear()).slice(-2); // Últimos 2 dígitos do ano
    
    // Formato: #ID-DDMMYY (Ex: #244-201025)
    return `#${ticketId}-${day}${month}${year}`;
}
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Normaliza o nome do arquivo: remove espaços, acentos e caracteres especiais
        function normalize(str) {
            return str
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
                .replace(/[^a-zA-Z0-9._-]/g, '_'); // troca caracteres especiais por _
        }
        const original = normalize(file.originalname);
        const uniqueName = Date.now() + '-' + original;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 16 * 1024 * 1024 // Limite de 16MB
    },
    fileFilter: function (req, file, cb) {
        // Aceita diversos tipos de arquivo
        const allowedMimes = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'application/pdf', 
            'application/msword', 
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel', 
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/plain',
            'video/mp4', 'video/mpeg',
            'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm'
        ];
        
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de arquivo não suportado.'));
        }
    }
});

const app = express();

// Middlewares para parse de JSON e URL-encoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos da pasta uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
const port = process.env.PORT || 5500;
const server = http.createServer(app);
// Inicializa o Socket.IO passando o servidor HTTP e configurando o CORS.
// Isso garante uma vinculação mais robusta e evita problemas de conexão.
const io = new Server(server, {
  cors: {
    origin: "*", // Em produção, restrinja para o seu domínio: "http://localhost:5500"
    methods: ["GET", "POST"]
  }
});

// Objeto para gerenciar as sessões do WhatsApp
const sessions = {};

// Contador de erros críticos por sessão (evita destruição prematura)
const sessionCriticalErrors = {}; // connectionId -> count
const MAX_CRITICAL_ERRORS = 5; // só destrói após 5 erros consecutivos

// Timers para pendentes de seleção de fila: reminder (1min) e final (3min)
const pendingTimers = {}; // contact_number -> { reminder: Timeout, final: Timeout }

function clearPendingTimers(contactNumber) {
    if (!contactNumber) return;
    const t = pendingTimers[contactNumber];
    if (!t) return;
    try { if (t.reminder) clearTimeout(t.reminder); } catch(e){}
    try { if (t.final) clearTimeout(t.final); } catch(e){}
    delete pendingTimers[contactNumber];
}

function schedulePendingTimers(contactNumber, connectionId) {
    // limpa quaisquer timers existentes
    clearPendingTimers(contactNumber);

    // Mensagem de lembrete após 1 minuto
    const reminder = setTimeout(() => {
        db.get('SELECT contact_number, connection_id FROM pending_queue_selection WHERE contact_number = ? AND connection_id = ?', [contactNumber, connectionId], (err, row) => {
            if (err || !row) return clearPendingTimers(contactNumber);

            // Busca client e connection config antes de enviar
            const client = sessions[String(connectionId)];
            db.get('SELECT start_time, end_time, chatbot_enabled FROM connections WHERE id = ?', [connectionId], async (cErr, connRow) => {
                if (cErr || !connRow) return;
                if (connRow.chatbot_enabled !== 1) return;
                if (connRow.start_time && connRow.end_time && !isWithinBusinessHours(connRow.start_time, connRow.end_time)) return;

                const reminderMsg = `🤖 *Robô I Automático* 💬

Ops! Parece que nenhuma opção foi selecionada ainda.

Por favor, escolha um número válido para prosseguirmos...`;
                try {
                    const contactId = `${contactNumber}@c.us`;
                    if (client) {
                        try { await client.sendMessage(contactId, reminderMsg); } catch (sendErr) { logger.warn(`Erro ao enviar lembrete para ${contactNumber}: ${sendErr.message}`); }
                    } else {
                        logger.info(`[pendingTimers] Cliente não disponível para enviar lembrete a ${contactNumber}`);
                    }
                } catch (e) { logger.error(`Erro no reminder timer para ${contactNumber}: ${e.message}`); }
            });
        });
    }, 60 * 1000);

    // Mensagem final/encerramento após 3 minutos
    const final = setTimeout(() => {
        db.get('SELECT contact_number, connection_id FROM pending_queue_selection WHERE contact_number = ? AND connection_id = ?', [contactNumber, connectionId], (err, row) => {
            if (err || !row) return clearPendingTimers(contactNumber);

            const client = sessions[String(connectionId)];
            db.get('SELECT start_time, end_time, chatbot_enabled FROM connections WHERE id = ?', [connectionId], async (cErr, connRow) => {
                if (cErr || !connRow) return;
                if (connRow.chatbot_enabled !== 1) return;
                if (connRow.start_time && connRow.end_time && !isWithinBusinessHours(connRow.start_time, connRow.end_time)) return;

                const finalMsg = `🤖 *Robô I Automático* 💬\n\n⚠ Nenhuma opção foi escolhida.\nO atendimento será encerrado🛑\n\nAté logo 🙂👋`;
                try {
                    const contactId = `${contactNumber}@c.us`;
                    if (client) {
                        try { await client.sendMessage(contactId, finalMsg); } catch (sendErr) { logger.warn(`Erro ao enviar mensagem final para ${contactNumber}: ${sendErr.message}`); }
                    } else {
                        logger.info(`[pendingTimers] Cliente não disponível para enviar final message a ${contactNumber}`);
                    }
                } catch (e) { logger.error(`Erro no final timer para ${contactNumber}: ${e.message}`); }

                // Remove o pendente e limpa timers
                db.run('DELETE FROM pending_queue_selection WHERE contact_number = ? AND connection_id = ?', [contactNumber, connectionId], (delErr) => {
                    if (delErr) logger.warn(`Falha ao remover pending_queue_selection após timeout para ${contactNumber}: ${delErr.message}`);
                    clearPendingTimers(contactNumber);
                });
            });
        });
    }, 3 * 60 * 1000);

    pendingTimers[contactNumber] = { reminder, final };
}

// Wrapper para registrar e unificar envios via WhatsApp — facilita diagnóstico de envios duplicados
async function safeSendMessage(clientInstance, contact, payload, options) {
    const ts = Date.now();
    // pega trecho da mensagem para logs (até 200 chars)
    const snippet = (typeof payload === 'string') ? payload.substring(0,200) : (payload && payload.caption ? String(payload.caption).substring(0,200) : '[media]');
    const stack = new Error().stack.split('\n').slice(2,6).join(' | ');
    try {
        logger.info(`[safeSend] attempting send at ${ts} contact=${contact} snippet="${snippet.replace(/\n/g,' ')}" caller=${stack}`);
        if (options) {
            return await clientInstance.sendMessage(contact, payload, options);
        }
        return await clientInstance.sendMessage(contact, payload);
    } catch (err) {
        logger.warn(`[safeSend] send failed at ${ts} contact=${contact} err=${err && err.message ? err.message : String(err)} caller=${stack}`);
        throw err;
    }
}

// Proteções para evitar reinicializações concorrentes / loops
const initializing = {}; // clientId -> boolean
const failCounts = {}; // clientId -> número de falhas consecutivas
const lastFail = {}; // clientId -> timestamp da última falha

// Configuráveis via ENV (valores seguros por padrão)
const INIT_TIMEOUT_MS = parseInt(process.env.INIT_TIMEOUT_MS, 10) || 90000; // 90s
const INIT_BACKOFF_MS = parseInt(process.env.INIT_BACKOFF_MS, 10) || 60000; // 60s
const INIT_MAX_RETRIES = parseInt(process.env.INIT_MAX_RETRIES, 10) || 3;

// Objeto para armazenar temporariamente os QR Codes gerados
const qrCodes = {};
const qrStore = {};

// Criar tabela de conexões se não existir
db.run(`CREATE TABLE IF NOT EXISTS connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            is_default BOOLEAN,
            birthday_message TEXT,
            farewell_message TEXT,
            status TEXT DEFAULT 'DISCONNECTED', 
            last_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            session_data TEXT 
        )`);
        
        // Migração: adicionar coluna chatbot_enabled para habilitar/desabilitar bot
        db.all("PRAGMA table_info('connections')", (err, columns) => {
            if (err) {
                logger.warn(`Falha ao inspecionar tabela connections: ${err.message}`);
            } else {
                const hasChatbotEnabled = columns.some(c => c.name === 'chatbot_enabled');
                const hasStartTime = columns.some(c => c.name === 'start_time');
                const hasEndTime = columns.some(c => c.name === 'end_time');
                
                if (!hasChatbotEnabled) {
                    db.run("ALTER TABLE connections ADD COLUMN chatbot_enabled INTEGER DEFAULT 1", (alterErr) => {
                        if (alterErr) {
                            logger.warn(`Não foi possível adicionar coluna chatbot_enabled (pode já existir): ${alterErr.message}`);
                        } else {
                            logger.info('Coluna chatbot_enabled adicionada à tabela connections.');
                        }
                    });
                }
                
                if (!hasStartTime) {
                    db.run("ALTER TABLE connections ADD COLUMN start_time TEXT", (alterErr) => {
                        if (alterErr) {
                            logger.warn(`Não foi possível adicionar coluna start_time: ${alterErr.message}`);
                        } else {
                            logger.info('Coluna start_time adicionada à tabela connections.');
                        }
                    });
                }
                
                if (!hasEndTime) {
                    db.run("ALTER TABLE connections ADD COLUMN end_time TEXT", (alterErr) => {
                        if (alterErr) {
                            logger.warn(`Não foi possível adicionar coluna end_time: ${alterErr.message}`);
                        } else {
                            logger.info('Coluna end_time adicionada à tabela connections.');
                        }
                    });
                }
            }
        });
        
        // Criar tabela de tickets se não existir
        db.run(`CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_name TEXT NOT NULL,
            contact_number TEXT NOT NULL,
            profile_pic_url TEXT,
            last_message TEXT,
            status TEXT DEFAULT 'pending',
            unread_messages INTEGER DEFAULT 0,
            last_message_at DATETIME,
            connection_id INTEGER,
            queue_id INTEGER,
            user_id INTEGER,
            protocol_number TEXT,
            FOREIGN KEY (connection_id) REFERENCES connections (id)
        )`);
        // Migração: adicionar coluna is_on_hold para diferenciar PENDENTE (1) de AGUARDANDO (0)
        db.all("PRAGMA table_info('tickets')", (err, columns) => {
            if (err) {
                logger.warn(`Falha ao inspecionar tabela tickets: ${err.message}`);
            } else {
                const hasOnHold = columns.some(c => c.name === 'is_on_hold');
                if (!hasOnHold) {
                    db.run("ALTER TABLE tickets ADD COLUMN is_on_hold INTEGER DEFAULT 0", (alterErr) => {
                        if (alterErr) {
                            logger.warn(`Não foi possível adicionar coluna is_on_hold (pode já existir): ${alterErr.message}`);
                        } else {
                            logger.info('Coluna is_on_hold adicionada à tabela tickets.');
                        }
                    });
                }
                
                const hasProtocol = columns.some(c => c.name === 'protocol_number');
                if (!hasProtocol) {
                    db.run("ALTER TABLE tickets ADD COLUMN protocol_number TEXT", (alterErr) => {
                        if (alterErr) {
                            logger.warn(`Não foi possível adicionar coluna protocol_number (pode já existir): ${alterErr.message}`);
                        } else {
                            logger.info('Coluna protocol_number adicionada à tabela tickets.');
                        }
                    });
                }
                // Flag para tickets criados manualmente
                const hasIsManual = columns.some(c => c.name === 'is_manual');
                if (!hasIsManual) {
                    db.run("ALTER TABLE tickets ADD COLUMN is_manual INTEGER DEFAULT 0", (alterErr) => {
                        if (alterErr) {
                            logger.warn(`Não foi possível adicionar coluna is_manual (pode já existir): ${alterErr.message}`);
                        } else {
                            logger.info('Coluna is_manual adicionada à tabela tickets.');
                            // Backfill inicial: marcar tickets existentes sem connection_id como manuais
                            db.run("UPDATE tickets SET is_manual = 1 WHERE connection_id IS NULL", (bfErr) => {
                                if (bfErr) {
                                    logger.warn(`Falha ao realizar backfill is_manual: ${bfErr.message}`);
                                } else {
                                    logger.info('Backfill is_manual concluído para tickets sem connection_id.');
                                }
                            });
                        }
                    });
                } else {
                    // Executar backfill idempotente em cada inicialização para garantir consistência
                    db.run("UPDATE tickets SET is_manual = 1 WHERE connection_id IS NULL AND (is_manual IS NULL OR is_manual = 0)", (bfErr) => {
                        if (bfErr) {
                            logger.warn(`Falha ao executar backfill idempotente is_manual: ${bfErr.message}`);
                        } else {
                            logger.info('Backfill idempotente is_manual aplicado (tickets sem connection_id marcados como manuais).');
                        }
                    });
                }
            }
        });
        // Criar tabela de mensagens se não existir
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id INTEGER NOT NULL,
            body TEXT NOT NULL,
            sender TEXT NOT NULL, -- 'bot' ou 'contact'
            user_id INTEGER, -- ID do usuário que enviou (se sender='bot')
            user_name TEXT, -- Nome do usuário que enviou (para histórico)
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            file_expires_at DATETIME,
            FOREIGN KEY (ticket_id) REFERENCES tickets (id),
            FOREIGN KEY (user_id) REFERENCES users (id)
        )`);
        
        // Migração: adicionar coluna file_expires_at à tabela messages
        db.all("PRAGMA table_info('messages')", (err, columns) => {
            if (err) {
                logger.warn(`Falha ao inspecionar tabela messages: ${err.message}`);
            } else {
                const hasFileExpiresAt = columns.some(c => c.name === 'file_expires_at');
                if (!hasFileExpiresAt) {
                    db.run("ALTER TABLE messages ADD COLUMN file_expires_at DATETIME", (alterErr) => {
                        if (alterErr) {
                            logger.warn(`Não foi possível adicionar coluna file_expires_at: ${alterErr.message}`);
                        } else {
                            logger.info('Coluna file_expires_at adicionada à tabela messages.');
                        }
                    });
                }
                
                const hasUserId = columns.some(c => c.name === 'user_id');
                if (!hasUserId) {
                    db.run("ALTER TABLE messages ADD COLUMN user_id INTEGER", (alterErr) => {
                        if (alterErr) {
                            logger.warn(`Não foi possível adicionar coluna user_id: ${alterErr.message}`);
                        } else {
                            logger.info('Coluna user_id adicionada à tabela messages.');
                        }
                    });
                }
                
                const hasUserName = columns.some(c => c.name === 'user_name');
                if (!hasUserName) {
                    db.run("ALTER TABLE messages ADD COLUMN user_name TEXT", (alterErr) => {
                        if (alterErr) {
                            logger.warn(`Não foi possível adicionar coluna user_name: ${alterErr.message}`);
                        } else {
                            logger.info('Coluna user_name adicionada à tabela messages.');
                        }
                    });
                }
            }
        });
        
        // Tabela de auditoria para eventos de sistema (takeover, reassign, etc.)
        db.run(`CREATE TABLE IF NOT EXISTS ticket_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            user_id INTEGER,
            user_name TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            metadata TEXT
        )`);
        
        // Migração: adicionar coluna gender à tabela users
        db.all("PRAGMA table_info('users')", (err, columns) => {
            if (err) {
                logger.warn(`Falha ao inspecionar tabela users: ${err.message}`);
            } else {
                const hasGender = columns.some(c => c.name === 'gender');
                if (!hasGender) {
                    db.run("ALTER TABLE users ADD COLUMN gender TEXT DEFAULT 'neutral'", (alterErr) => {
                        if (alterErr) {
                            logger.warn(`Não foi possível adicionar coluna gender: ${alterErr.message}`);
                        } else {
                            logger.info('Coluna gender adicionada à tabela users. Valores possíveis: female, male, neutral');
                        }
                    });
                }
            }
        });
        
        // Criar tabela de filas (queues) se não existir
        db.run(`CREATE TABLE IF NOT EXISTS queues (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            color TEXT
        )`);
        // Tabela de associação entre conexões e filas (Muitos-para-Muitos)
        db.run(`CREATE TABLE IF NOT EXISTS connection_queues (
            connection_id INTEGER NOT NULL,
            queue_id INTEGER NOT NULL,
            PRIMARY KEY (connection_id, queue_id),
            FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
        )`);

        // Tabela para rastrear sessões de usuários online
        db.run(`CREATE TABLE IF NOT EXISTS user_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            session_token TEXT UNIQUE NOT NULL,
            last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        // Tabela para controlar cooldown do bot após envio de mensagem de despedida
        db.run(`CREATE TABLE IF NOT EXISTS bot_cooldown (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_number TEXT NOT NULL UNIQUE,
            cooldown_until DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Tabela temporária para armazenar conversas pendentes de seleção de fila
        db.run(`CREATE TABLE IF NOT EXISTS pending_queue_selection (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_number TEXT NOT NULL UNIQUE,
            contact_name TEXT,
            profile_pic_url TEXT,
            connection_id INTEGER NOT NULL,
            first_message TEXT,
            first_message_timestamp DATETIME,
            invalid_attempts INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            initial_sent INTEGER DEFAULT 0,
            FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
        )`);

        // Migração defensiva: garante coluna initial_sent na tabela pending_queue_selection
        db.all("PRAGMA table_info('pending_queue_selection')", (pqErr, pqCols) => {
            if (pqErr) {
                logger.warn(`Falha ao inspecionar colunas de pending_queue_selection: ${pqErr.message}`);
            } else {
                const hasInitialSent = Array.isArray(pqCols) && pqCols.some(c => c.name === 'initial_sent');
                if (!hasInitialSent) {
                    db.run("ALTER TABLE pending_queue_selection ADD COLUMN initial_sent INTEGER DEFAULT 0", (alterErr) => {
                        if (alterErr) logger.warn(`Falha ao adicionar coluna initial_sent em pending_queue_selection: ${alterErr.message}`);
                        else logger.info("Coluna initial_sent adicionada à tabela pending_queue_selection");
                    });
                }
            }
        });

        // Tabela de Respostas Rápidas (Quick Responses)
        db.run(`CREATE TABLE IF NOT EXISTS quick_responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            shortcut TEXT NOT NULL,
            response TEXT NOT NULL,
            user_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(shortcut, user_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        // Migração: garantir colunas created_at, updated_at e user_id em quick_responses
        db.all("PRAGMA table_info('quick_responses')", (qrErr, qrCols) => {
            if (qrErr) {
                logger.warn(`Falha ao inspecionar tabela quick_responses: ${qrErr.message}`);
                return;
            }
            const hasCreatedAt = qrCols.some(c => c.name === 'created_at');
            const hasUpdatedAt = qrCols.some(c => c.name === 'updated_at');
            const hasUserId = qrCols.some(c => c.name === 'user_id');
            
            if (!hasCreatedAt) {
                db.run("ALTER TABLE quick_responses ADD COLUMN created_at DATETIME", (altErr) => {
                    if (altErr) logger.warn(`Falha ao adicionar coluna created_at em quick_responses: ${altErr.message}`);
                    else {
                        logger.info('Coluna created_at adicionada à quick_responses.');
                        db.run("UPDATE quick_responses SET created_at = COALESCE(created_at, datetime('now','localtime'))", (uErr) => {
                            if (uErr) logger.warn(`Falha ao popular created_at em quick_responses: ${uErr.message}`);
                        });
                    }
                });
            }
            if (!hasUpdatedAt) {
                db.run("ALTER TABLE quick_responses ADD COLUMN updated_at DATETIME", (altErr) => {
                    if (altErr) logger.warn(`Falha ao adicionar coluna updated_at em quick_responses: ${altErr.message}`);
                    else {
                        logger.info('Coluna updated_at adicionada à quick_responses.');
                        db.run("UPDATE quick_responses SET updated_at = COALESCE(updated_at, datetime('now','localtime'))", (uErr) => {
                            if (uErr) logger.warn(`Falha ao popular updated_at em quick_responses: ${uErr.message}`);
                        });
                    }
                });
            }
            if (!hasUserId) {
                db.run("ALTER TABLE quick_responses ADD COLUMN user_id INTEGER", (altErr) => {
                    if (altErr) logger.warn(`Falha ao adicionar coluna user_id em quick_responses: ${altErr.message}`);
                    else {
                        logger.info('Coluna user_id adicionada à quick_responses.');
                    }
                });
            }
        });

        // Tabela de Permissões por Perfil
        db.run(`CREATE TABLE IF NOT EXISTS permissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile TEXT NOT NULL,
            module TEXT NOT NULL,
            can_view INTEGER DEFAULT 1,
            can_edit INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(profile, module)
        )`);

        // Inserir permissões padrão se a tabela estiver vazia
        db.get('SELECT COUNT(*) as cnt FROM permissions', [], (err, row) => {
            if (err) {
                logger.warn(`Falha ao verificar permissões existentes: ${err.message}`);
                return;
            }
            
            if (row && row.cnt === 0) {
                // Módulos disponíveis no sistema
                const modules = [
                    'dashboard',
                    'tickets',
                    'connections',
                    'users',
                    'queues',
                    'quick_responses',
                    'internal_chat',
                    'permissions',
                    'reports'
                ];
                
                const profiles = ['admin', 'supervisor', 'usuario'];
                
                // Admin tem acesso total a tudo
                modules.forEach(module => {
                    db.run('INSERT INTO permissions (profile, module, can_view, can_edit) VALUES (?, ?, ?, ?)',
                        ['admin', module, 1, 1]);
                });
                
                // Supervisor tem acesso a visualizar tudo, mas editar apenas alguns módulos
                modules.forEach(module => {
                    const canEdit = ['tickets', 'quick_responses', 'internal_chat'].includes(module) ? 1 : 0;
                    db.run('INSERT INTO permissions (profile, module, can_view, can_edit) VALUES (?, ?, ?, ?)',
                        ['supervisor', module, 1, canEdit]);
                });
                
                // Usuário tem acesso limitado
                const userModules = ['dashboard', 'tickets', 'quick_responses', 'internal_chat'];
                modules.forEach(module => {
                    const canView = userModules.includes(module) ? 1 : 0;
                    const canEdit = ['tickets', 'quick_responses', 'internal_chat'].includes(module) ? 1 : 0;
                    db.run('INSERT INTO permissions (profile, module, can_view, can_edit) VALUES (?, ?, ?, ?)',
                        ['usuario', module, canView, canEdit]);
                });
                
                logger.info('Permissões padrão inseridas com sucesso.');
            }
        });

        // Limpeza automática de cooldowns expirados a cada 5 minutos
        setInterval(() => {
            const now = new Date().toISOString();
            db.run('DELETE FROM bot_cooldown WHERE cooldown_until < ?', [now], function(err) {
                if (err) {
                    logger.warn(`Erro ao limpar cooldowns expirados: ${err.message}`);
                } else if (this.changes > 0) {
                    logger.info(`Limpeza automática: ${this.changes} cooldown(s) expirado(s) removido(s).`);
                }
            });
        }, 5 * 60 * 1000); // A cada 5 minutos

// --- Funções do WhatsApp ---

// Função para reinicializar conexões que estavam ativas antes de o servidor reiniciar
function reinitializeActiveConnections() {
    db.all("SELECT id FROM connections WHERE status = 'CONNECTED'", [], (err, rows) => {
        if (err) {
            logger.error(`Falha ao buscar conexões ativas para reinicializar: ${err.message}`);
            return;
        }
        if (rows.length > 0) {
            logger.info(`Encontradas ${rows.length} conexões ativas. Tentando reinicializar...`);
            rows.forEach(conn => {
                // Usamos a mesma função de inicialização, mas sem o objeto 'res' da requisição HTTP
                // A biblioteca whatsapp-web.js tentará restaurar a sessão sem precisar de um novo QR Code.
                initializeConnection(conn.id);
            });
        }
    });

    // --- Verificação de schema (coluna is_on_hold) e indicadores de versão ---
    const APP_VERSION = '1.1.0-pending-split';
    let HAS_ON_HOLD_COLUMN = false;
    function detectOnHoldColumn(callback) {
        db.all("PRAGMA table_info('tickets')", (err, columns) => {
            if (err) {
                logger.warn(`Falha ao inspecionar tabela tickets (health check): ${err.message}`);
                HAS_ON_HOLD_COLUMN = false;
                return callback && callback(err);
            }
            HAS_ON_HOLD_COLUMN = columns.some(c => c.name === 'is_on_hold');
            if (!HAS_ON_HOLD_COLUMN) {
                logger.warn('Coluna is_on_hold não detectada. Tentando adicionar...');
                db.run("ALTER TABLE tickets ADD COLUMN is_on_hold INTEGER DEFAULT 0", (alterErr) => {
                    if (alterErr) {
                        logger.warn(`Não foi possível adicionar coluna is_on_hold agora: ${alterErr.message}`);
                    } else {
                        logger.info('Coluna is_on_hold adicionada com sucesso após verificação.');
                        HAS_ON_HOLD_COLUMN = true;
                    }
                    callback && callback(alterErr);
                });
            } else {
                callback && callback();
            }
        });
    }
    detectOnHoldColumn();

    // Rota de health check para confirmar versão e schema
    app.get('/api/health', (req, res) => {
        detectOnHoldColumn(() => {
            res.json({
                status: 'ok',
                version: APP_VERSION,
                has_on_hold: HAS_ON_HOLD_COLUMN,
                port: port
            });
        });
    });

    // Rota de seed (apenas desenvolvimento) para criar ticket PENDENTE
    app.post('/api/dev/seed-pending', (req, res) => {
        if (process.env.NODE_ENV === 'production') {
            return res.status(403).json({ message: 'Indisponível em produção.' });
        }
        const now = getLocalDateTime();
        const sql = `INSERT INTO tickets (contact_name, contact_number, profile_pic_url, last_message, status, unread_messages, last_message_at, connection_id, queue_id, user_id, is_on_hold)
                     VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, 1)`;
        db.run(sql, ['Contato Seed Pendente', '000000000', null, 'Ticket seed criado como PENDENTE', now], function(err) {
            if (err) return res.status(500).json({ message: 'Falha ao criar seed', error: err.message });
            const newTicketId = this.lastID;
            const protocolNumber = generateProtocolNumber(newTicketId);
            
            // Atualiza o ticket com o protocolo
            db.run('UPDATE tickets SET protocol_number = ? WHERE id = ?', [protocolNumber, newTicketId], (updateErr) => {
                if (updateErr) logger.error(`Erro ao atualizar protocolo: ${updateErr.message}`);
            });
            
            res.status(201).json({ id: newTicketId, protocol_number: protocolNumber });
        });
    });
}

// --- Funções do WhatsApp ---

// Função auxiliar para deletar TODAS as outras pastas de sessão
function deleteOldSessionFolder(clientId) {
    const authDir = path.join(__dirname, '.wwebjs_auth');
    
    // Verifica se o diretório .wwebjs_auth existe
    if (!fs.existsSync(authDir)) {
        logger.info('Pasta .wwebjs_auth não existe ainda.');
        return true;
    }
    
    try {
        // Lista todas as pastas dentro de .wwebjs_auth
        const items = fs.readdirSync(authDir, { withFileTypes: true });
        
        let deletedCount = 0;
        for (const item of items) {
            if (item.isDirectory() && item.name.startsWith('session-')) {
                const fullPath = path.join(authDir, item.name);
                
                // Deleta QUALQUER pasta de sessão (incluindo a atual se existir, e todas as outras)
                try {
                    fs.rmSync(fullPath, {recursive: true, force: true});
                    logger.info(`Deletando pasta de sessão: ${fullPath}`);
                    deletedCount++;
                } catch (e) {
                    logger.error(`Erro ao deletar pasta ${fullPath}: ${e.message}`);
                }
            }
        }
        
        if (deletedCount > 0) {
            logger.info(`Total de ${deletedCount} pasta(s) de sessão deletada(s) com sucesso.`);
        } else {
            logger.info(`Nenhuma pasta de sessão encontrada para deletar.`);
        }
        
        return true;
    } catch (e) {
        logger.error(`Erro ao limpar pastas de sessão: ${e.message}`);
        return false;
    }
}

// API for connections
// GET all connections
app.get('/api/connections', (req, res) => {
    db.all("SELECT id, name, status, is_default, last_updated_at FROM connections", [], (err, rows) => {
        if (err) {
            res.status(500).json({ "error": err.message });
            return;
        }
        res.json(rows);
    });
});

// POST para inicializar uma conexão e gerar QR Code
async function initializeConnection(id, res = null) {
    const clientId = String(id);

    // Evita inicializações concorrentes para a mesma clientId
    if (initializing[clientId]) {
        logger.warn(`Tentativa de reinicializar a sess\u00e3o ${clientId} que j\u00e1 est\u00e1 em andamento.`);
        if (res && !res.headersSent) return res.status(202).json({ message: 'Inicializa\u00e7\u00e3o em andamento.' });
        return;
    }

    // Se houver muitas falhas recentes, aplica backoff
    const nowTs = Date.now();
    if (failCounts[clientId] && failCounts[clientId] >= INIT_MAX_RETRIES) {
        const since = nowTs - (lastFail[clientId] || 0);
        if (since < INIT_BACKOFF_MS) {
            logger.warn(`Backoff ativo para a sess\u00e3o ${clientId}. aguardando ${Math.ceil((INIT_BACKOFF_MS - since)/1000)}s antes de tentar novamente.`);
            if (res && !res.headersSent) return res.status(429).json({ message: 'Too many attempts. Backoff ativo.' });
            return;
        } else {
            // Reseta contador após período de backoff
            failCounts[clientId] = 0;
        }
    }

    // Marca como inicializando
    initializing[clientId] = true;

    // Garante que qualquer sessão 'fantasma' seja destruída antes de iniciar uma nova.
    if (sessions[clientId]) {
        logger.warn(`Sessão ${clientId} já existe. Destruindo a sessão antiga antes de criar uma nova.`);
        try {
            await sessions[clientId].destroy();
        } catch (e) {
            logger.error(`Erro ao destruir a sessão antiga ${clientId}: ${e.message}`);
        } finally {
            delete sessions[clientId];
            // Limpa também o QR code antigo, se houver
            delete qrStore[id];
        }
    }

    // Deleta a pasta de sessão antiga automaticamente antes de criar uma nova
    deleteOldSessionFolder(clientId);
    
    logger.info(`Inicializando sessão para a conexão: ${id}`);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: clientId }),
        puppeteer: {
            // Deixar o executablePath comentado força o whatsapp-web.js a usar sua própria versão do Chromium,
            // o que é mais estável e evita problemas de compatibilidade.
            // executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ]
        }
    });

    // Adiciona a sessão ao gerenciador imediatamente para evitar condições de corrida
    sessions[clientId] = client;

    // Timer de timeout para a inicialização (limpa e força abort se ultrapassar)
    let initTimeout = setTimeout(async () => {
        logger.error(`Timeout de ${INIT_TIMEOUT_MS/1000}s atingido para a inicializa\u00e7\u00e3o da sess\u00e3o ${id}. Abortando.`);
        try {
            if (sessions[clientId]) {
                await sessions[clientId].destroy();
                logger.info(`Cliente da sess\u00e3o ${id} destru\u00eddo por timeout.`);
            }
        } catch (e) {
            logger.warn(`Erro ao destruir cliente por timeout para sess\u00e3o ${id}: ${e.message}`);
        } finally {
            delete sessions[clientId];
            delete qrStore[id];
            initializing[clientId] = false;
            // conta falha
            failCounts[clientId] = (failCounts[clientId] || 0) + 1;
            lastFail[clientId] = Date.now();
        }
    }, INIT_TIMEOUT_MS);

    client.on('authenticated', () => {
        logger.info(`Sessão ${id} autenticada.`);
        // Limpa qualquer QR pendente assim que a autenticação acontece.
        delete qrStore[id];
        db.run('UPDATE connections SET status = ?, last_updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['CONNECTED', id], (err) => {
            if (err) {
                logger.error(`Falha ao marcar conexão ${id} como CONNECTED após autenticação: ${err.message}`);
            } else {
                io.emit('connection_update', { id: id, status: 'CONNECTED' });
            }
        });
    });

    client.on('auth_failure', (message) => {
        logger.warn(`Autenticação falhou para a sessão ${id}: ${message}`);
        delete qrStore[id];
        db.run('UPDATE connections SET status = ?, last_updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['DISCONNECTED', id], (err) => {
            if (err) {
                logger.error(`Falha ao marcar conexão ${id} como DISCONNECTED após falha de autenticação: ${err.message}`);
            } else {
                io.emit('connection_update', { id: id, status: 'DISCONNECTED' });
            }
        });
        // limpa flag e incrementa contador de falhas
        initializing[clientId] = false;
        failCounts[clientId] = (failCounts[clientId] || 0) + 1;
        lastFail[clientId] = Date.now();
        clearTimeout(initTimeout);
    });

    client.on('ready', () => {
        logger.info(`Sessão ${id} conectada!`);
        db.run('UPDATE connections SET status = ?, last_updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['CONNECTED', id], (err) => {
            if (!err) io.emit('connection_update', { id: id, status: 'CONNECTED' });
        });
        // A conexão está pronta, podemos remover o listener de QR
        client.removeListener('qr', qrListener);
        // sucesso -> reset counters e flags
        initializing[clientId] = false;
        failCounts[clientId] = 0;
        lastFail[clientId] = null;
        clearTimeout(initTimeout);
        
        // Handler para novas mensagens
        client.on('message', async (msg) => {
            if (msg.fromMe) return;

            // Filtrar mensagens que não são conversas normais
            if (msg.type !== 'chat' && msg.type !== 'text' && msg.type !== 'image' && msg.type !== 'video' && msg.type !== 'audio' && msg.type !== 'document' && msg.type !== 'sticker' && msg.type !== 'ptt') {
                logger.info(`[WA inbound] Mensagem ignorada - tipo ${msg.type} de ${msg.from}`);
                return;
            }

            // Filtrar mensagens de status e broadcast
            if (msg.from === 'status@broadcast' || msg.from.includes('@broadcast') || msg.from.includes('@g.us')) {
                logger.info(`[WA inbound] Mensagem de broadcast/status/grupo ignorada de ${msg.from} (tipo: ${msg.type})`);
                return;
            }

            // Log inicial da mensagem recebida
            try { logger.info(`[WA inbound] Mensagem recebida na conexão ${id} de ${msg.from}: tipo=${msg.type || 'text'}`); } catch(_) {}

            const contact = await msg.getContact();
            let profilePicUrl = null;
            try {
                profilePicUrl = await contact.getProfilePicUrl();
            } catch (e) {
                logger.warn(`Falha ao obter foto de perfil de ${msg.from}: ${e.message}`);
            }
            const contactNumber = msg.from.replace('@c.us', '');
            const contactName = contact.name || contact.pushname || contactNumber;
            const messageTime = getLocalDateTime();
            
            let messageBody = msg.body;
            let hasFile = false;
            let savedFileName = null;
            
            // Verifica se a mensagem tem mídia (arquivo anexado)
            if (msg.hasMedia) {
                try {
                    logger.info(`Baixando mídia da mensagem de ${contactNumber}...`);
                    const media = await msg.downloadMedia();
                    
                    if (media) {
                        // Gera nome único para o arquivo
                        const extension = media.mimetype.split('/')[1].split(';')[0];
                        const fileName = `${Date.now()}-received.${extension}`;
                        const filePath = path.join(uploadDir, fileName);
                        
                        // Salva o arquivo
                        const buffer = Buffer.from(media.data, 'base64');
                        fs.writeFileSync(filePath, buffer);
                        
                        savedFileName = fileName;
                        hasFile = true;
                        messageBody = `[Arquivo: ${fileName}]`;
                        
                        logger.info(`Arquivo salvo: ${fileName}`);
                    }
                } catch (mediaError) {
                    logger.error(`Erro ao baixar mídia: ${mediaError.message}`);
                    messageBody = msg.body || '[Arquivo não pôde ser baixado]';
                }
            }

            // Busca ticket ATIVO (não resolvido) para o contato
            // Busca por tickets com connection_id específico OU sem connection_id (criados manualmente)
            db.get('SELECT * FROM tickets WHERE contact_number = ? AND (connection_id = ? OR connection_id IS NULL) AND status != "resolved" ORDER BY CASE WHEN connection_id = ? THEN 1 ELSE 2 END, id DESC LIMIT 1', [contactNumber, id, id], (err, ticket) => {
                if (err) return logger.error(`Erro ao buscar ticket: ${err.message}`);
                logger.info(`[WA inbound] Ticket ativo ${ticket ? 'encontrado (ID: ' + ticket.id + ')' : 'não encontrado'} para ${contactNumber} (conn ${id}).`);

                // Se não houver ticket, verifica se está pendente de seleção de fila
                if (!ticket) {
                    db.get('SELECT * FROM pending_queue_selection WHERE contact_number = ? AND connection_id = ?', [contactNumber, id], (pendErr, pendingRecord) => {
                        if (pendErr) {
                            logger.error(`Erro ao buscar registro pendente: ${pendErr.message}`);
                            return;
                        }
                        
                        if (pendingRecord) {
                            // Salva a mensagem recebida na tabela de mensagens pendentes
                            db.run('INSERT INTO pending_messages (contact_number, connection_id, body, sender, timestamp, media_type, media_data, wa_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 
                                [contactNumber, id, messageBody, 'contact', messageTime, hasFile ? 'file' : null, savedFileName || null, msg.id ? msg.id._serialized : null], 
                                function(msgErr) {
                                    if (msgErr) logger.warn(`Erro ao salvar mensagem pendente: ${msgErr.message}`);
                                });

                            // Contato está pendente de seleção - verifica se a mensagem é uma escolha válida
                            logger.info(`[WA inbound] Contato ${contactNumber} está pendente de seleção de fila.`);

                            // Regra: só enviar mensagem de "escolha inválida" após a mensagem inicial ter sido enviada
                            if (!pendingRecord.initial_sent) {
                                logger.info(`[WA inbound] Mensagem inicial ainda não enviada para ${contactNumber}. Enviando agora antes de validar escolha.`);

                                try {
                                    db.get('SELECT birthday_message, start_time, end_time FROM connections WHERE id = ?', [id], (cErr, connRow) => {
                                        if (cErr) {
                                            logger.warn(`Não foi possível obter mensagem inicial da conexão ${id}: ${cErr.message}`);
                                            return;
                                        }

                                        // Checa horário de funcionamento
                                        if (connRow && connRow.start_time && connRow.end_time) {
                                            if (!isWithinBusinessHours(connRow.start_time, connRow.end_time)) {
                                                logger.info(`[WA auto-message] Fora do horário (${connRow.start_time} - ${connRow.end_time}). Não enviando mensagem inicial para ${contactNumber}.`);
                                                return;
                                            }
                                        }

                                        const initialMessage = connRow && connRow.birthday_message ? String(connRow.birthday_message).trim() : null;

                                        // Busca filas habilitadas
                                        db.all(`SELECT q.name FROM connection_queues cq JOIN queues q ON cq.queue_id = q.id WHERE cq.connection_id = ? ORDER BY q.name ASC`, [id], async (qErr, qRows) => {
                                            if (qErr) {
                                                logger.warn(`Não foi possível obter filas da conexão ${id}: ${qErr.message}`);
                                            }

                                            let queuesText = null;
                                            if (qRows && qRows.length > 0) {
                                                queuesText = 'Por favor, informe *o número* da opção desejada - Ex:(1,2 ou 3...) ' + '\n\n---\n\n';
                                                qRows.forEach((row, idx) => {
                                                    queuesText += `${idx + 1}. ${row.name}` + '\n';
                                                });
                                            }

                                            (async () => {
                                                try {
                                                    const contactId = `${contactNumber}@c.us`;
                                                    if (!client) {
                                                        logger.warn(`[WA auto-message] Cliente WhatsApp não disponível. Pulando envios para ${contactNumber}.`);
                                                    } else {
                                                        let clientState = null;
                                                        try { clientState = await client.getState(); } catch (_) {}
                                                        if (clientState === 'CONNECTED') {
                                                            // Aguarda 10 segundos antes de enviar as mensagens
                                                            setTimeout(async () => {
                                                                // Verifica novamente se initial_sent ainda é 0 (proteção contra condições de corrida)
                                                                db.get('SELECT initial_sent FROM pending_queue_selection WHERE contact_number = ? AND connection_id = ?', [contactNumber, id], async (checkErr, checkRow) => {
                                                                    if (checkErr || !checkRow || checkRow.initial_sent === 1) {
                                                                        logger.info(`[WA auto-message] Mensagens já enviadas ou erro na verificação para ${contactNumber}, pulando.`);
                                                                        return;
                                                                    }
                                                                    
                                                                    if (initialMessage && initialMessage.length > 0) {
                                                                        try { await client.sendMessage(contactId, initialMessage); } catch (sendErr) { logger.error(`[WA auto-message] Erro ao enviar mensagem inicial para ${contactNumber}: ${sendErr.message}`); }
                                                                    }
                                                                    if (queuesText) {
                                                                        try { await client.sendMessage(contactId, queuesText); } catch (sendErr2) { logger.error(`[WA auto-message] Erro ao enviar lista de filas para ${contactNumber}: ${sendErr2.message}`); }
                                                                    }
                                                                    
                                                                    // Marca que as mensagens foram enviadas
                                                                    db.run('UPDATE pending_queue_selection SET initial_sent = 1 WHERE contact_number = ? AND connection_id = ?', [contactNumber, id], (updErr) => {
                                                                        if (updErr) logger.warn(`Erro ao marcar initial_sent para ${contactNumber}: ${updErr.message}`);
                                                                    });
                                                                });
                                                            }, 15000);
                                                        } else {
                                                            logger.warn(`[WA auto-message] Client não está conectado (estado=${clientState}). Não será enviada a mensagem automática para ${contactNumber}.`);
                                                        }
                                                    }
                                                } catch (outerErr) {
                                                    logger.error(`[WA auto-message] Erro ao processar mensagens automáticas para ${contactNumber}: ${outerErr.message}`);
                                                } finally {
                                                    // Não marca initial_sent aqui - será marcado dentro do setTimeout após envio
                                                }
                                            })();
                                        });
                                    });
                                } catch (ex) {
                                    logger.error(`Erro ao agendar envio de mensagem inicial para ${contactNumber}: ${ex.message}`);
                                }

                                // Não processa a mensagem atual como escolha até enviar a inicial
                                return;
                            }
                            
                            // Busca as filas associadas à conexão
                            db.all(`SELECT q.id, q.name FROM connection_queues cq JOIN queues q ON cq.queue_id = q.id WHERE cq.connection_id = ? ORDER BY q.name ASC`, [id], (mapErr, mapRows) => {
                                if (mapErr) {
                                    logger.warn(`Erro ao buscar filas para mapear escolha do usuário: ${mapErr.message}`);
                                    return;
                                }

                                if (!mapRows || mapRows.length === 0) {
                                    logger.warn(`Nenhuma fila encontrada para conexão ${id}`);
                                    return;
                                }

                                // Extrai o primeiro token da mensagem e tenta interpretar como número
                                const token = (messageBody || '').trim().split(/\s+/)[0];
                                const choice = parseInt(token, 10);
                                
                                if (!isNaN(choice) && choice >= 1 && choice <= mapRows.length) {
                                    // Escolha válida - CRIA O TICKET AGORA
                                    const chosen = mapRows[choice - 1];
                                    logger.info(`[WA inbound] Escolha válida detectada: ${choice} = ${chosen.name}. Criando ticket...`);
                                    
                                    // Cria o ticket com a fila já selecionada
                                    const createTicketSql = `INSERT INTO tickets (contact_name, contact_number, profile_pic_url, last_message, status, unread_messages, last_message_at, connection_id, is_on_hold, queue_id) VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, 0, ?)`;
                                    
                                    db.run(createTicketSql, [pendingRecord.contact_name, contactNumber, pendingRecord.profile_pic_url, messageBody, messageTime, id, chosen.id], function(createErr) {
                                        if (createErr) {
                                            logger.error(`Erro ao criar ticket após escolha de fila: ${createErr.message}`);
                                            return;
                                        }
                                        
                                        const newTicketId = this.lastID;
                                        const protocolNumber = generateProtocolNumber(newTicketId);
                                        
                                        // Atualiza o ticket com o protocolo
                                        db.run('UPDATE tickets SET protocol_number = ? WHERE id = ?', [protocolNumber, newTicketId], (updateErr) => {
                                            if (updateErr) logger.error(`Erro ao atualizar protocolo: ${updateErr.message}`);
                                        });
                                        
                                        logger.info(`[WA inbound] Ticket criado: ID=${newTicketId}, Protocolo=${protocolNumber}, Fila=${chosen.name}`);
                                        
                                        // Migra mensagens pendentes para o ticket criado
                                        db.all('SELECT * FROM pending_messages WHERE contact_number = ? AND connection_id = ? ORDER BY timestamp ASC', [contactNumber, id], (migErr, pendingMsgs) => {
                                            if (migErr) {
                                                logger.warn(`Erro ao buscar mensagens pendentes para migração: ${migErr.message}`);
                                            } else if (pendingMsgs && pendingMsgs.length > 0) {
                                                logger.info(`[WA inbound] Migrando ${pendingMsgs.length} mensagens pendentes para ticket ${newTicketId}`);
                                                
                                                // Insere cada mensagem pendente no ticket
                                                pendingMsgs.forEach((msg) => {
                                                    db.run('INSERT INTO messages (ticket_id, body, sender, timestamp, media_type, media_data, wa_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)', 
                                                        [newTicketId, msg.body, msg.sender, msg.timestamp, msg.media_type, msg.media_data, msg.wa_message_id], 
                                                        function(insErr) {
                                                            if (insErr) logger.warn(`Erro ao migrar mensagem pendente ${msg.id}: ${insErr.message}`);
                                                        });
                                                });
                                                
                                                // Remove mensagens migradas
                                                db.run('DELETE FROM pending_messages WHERE contact_number = ? AND connection_id = ?', [contactNumber, id], (delPendErr) => {
                                                    if (delPendErr) logger.warn(`Erro ao remover mensagens pendentes migradas: ${delPendErr.message}`);
                                                });
                                            }
                                        });
                                        
                                        // Remove registro pendente e limpa timers associados
                                        db.run('DELETE FROM pending_queue_selection WHERE contact_number = ? AND connection_id = ?', [contactNumber, id], (delErr) => {
                                            if (delErr) logger.warn(`Erro ao remover pending_queue_selection após criação de ticket para ${contactNumber}: ${delErr.message}`);
                                            clearPendingTimers(contactNumber);
                                        });
                                        
                                        // Salva a mensagem de escolha
                                        db.run('INSERT INTO messages (ticket_id, body, sender, timestamp) VALUES (?, ?, ?, ?)', 
                                            [newTicketId, messageBody, 'contact', messageTime],
                                            function(msgErr) {
                                                if (!msgErr) {
                                                    io.emit('new-message', {
                                                        id: this.lastID,
                                                        ticket_id: newTicketId,
                                                        body: messageBody,
                                                        sender: 'contact',
                                                        timestamp: messageTime
                                                    });
                                                }
                                            }
                                        );
                                        
                                        // Remove da tabela de pendentes
                                        db.run('DELETE FROM pending_queue_selection WHERE contact_number = ?', [contactNumber], (delErr) => {
                                            if (delErr) logger.warn(`Erro ao remover registro pendente: ${delErr.message}`);
                                            clearPendingTimers(contactNumber);
                                        });
                                        
                                        // Emite evento de novo ticket
                                        io.emit('ticket_update', { id: newTicketId, status: 'pending', queue_id: chosen.id });
                                        
                                        // Envia mensagem de confirmação
                                        (async () => {
                                            try {
                                                const contactId = `${contactNumber}@c.us`;
                                                if (client) {
                                                    const confirmText = `👋 Perfeito!\nVocê selecionou o setor *${chosen.name}*.\n\n📄 Seu atendimento foi registrado com o protocolo nº *${protocolNumber}*.\n\n💬 Um de nossos atendentes entrará em contato em breve.\n\nPara agilizar o seu atendimento, poderia adiantar alguns detalhes sobre o problema ou solicitação?`;
                                                    try {
                                                        await sendBotMessageIfUnassigned(client, contactId, newTicketId, confirmText);
                                                    } catch (sendErr) {
                                                        logger.error(`Erro ao enviar confirmação de fila via WhatsApp para ${contactNumber}: ${sendErr.message}`);
                                                    }
                                                } else {
                                                    logger.warn(`Cliente WhatsApp não disponível ao processar escolha de fila para ticket ${newTicketId}`);
                                                }
                                            } catch (e) {
                                                logger.error(`Erro inesperado ao processar escolha de fila para ticket ${newTicketId}: ${e.message}`);
                                            }
                                        })();
                                    });
                                } else {
                                    // Escolha inválida - incrementa contador
                                    const newAttempts = (pendingRecord.invalid_attempts || 0) + 1;
                                    
                                    db.run('UPDATE pending_queue_selection SET invalid_attempts = ? WHERE contact_number = ?', [newAttempts, contactNumber], (updErr) => {
                                        if (updErr) logger.warn(`Erro ao atualizar tentativas inválidas: ${updErr.message}`);
                                    });
                                    
                                    if (newAttempts >= 3) {
                                        // Remove da tabela de pendentes após 3 tentativas
                                        db.run('DELETE FROM pending_queue_selection WHERE contact_number = ?', [contactNumber], (delErr) => {
                                            if (delErr) logger.warn(`Erro ao remover registro pendente: ${delErr.message}`);
                                            clearPendingTimers(contactNumber);
                                        });
                                        
                                        // Verifica horário antes de enviar mensagem de encerramento
                                        db.get('SELECT start_time, end_time FROM connections WHERE id = ?', [id], (connErr, connRow) => {
                                            if (connErr) {
                                                logger.warn(`Erro ao buscar horários da conexão ${id}: ${connErr.message}`);
                                                return;
                                            }
                                            
                                            // Verifica se está dentro do horário de funcionamento
                                            if (connRow && connRow.start_time && connRow.end_time) {
                                                if (!isWithinBusinessHours(connRow.start_time, connRow.end_time)) {
                                                    logger.info(`[WA auto-message] Fora do horário de funcionamento (${connRow.start_time} - ${connRow.end_time}). Não enviando mensagem de encerramento para ${contactNumber}.`);
                                                    return;
                                                }
                                            }
                                            
                                            // Envia mensagem de encerramento
                                            const closingMsg = `🤖 *Robô I Automático* 💬\n\n⚠ Não identificamos uma resposta válida.\n\nPara manter a qualidade e agilidade do nosso atendimento, esta conversa será encerrada automaticamente.\n\n💬 Caso ainda precise de suporte, basta enviar uma nova mensagem para iniciar um novo atendimento.`;
                                            (async () => {
                                                try {
                                                    const contactId = `${contactNumber}@c.us`;
                                                    if (client) {
                                                        try {
                                                            await client.sendMessage(contactId, closingMsg);
                                                        } catch (sendErr) {
                                                            logger.error(`Erro ao enviar mensagem de encerramento via WhatsApp para ${contactNumber}: ${sendErr.message}`);
                                                        }
                                                    } else {
                                                        logger.warn(`Cliente WhatsApp não disponível ao enviar mensagem de encerramento para ${contactNumber}`);
                                                    }
                                                } catch (e) {
                                                    logger.error(`Erro ao processar encerramento por tentativas inválidas para ${contactNumber}: ${e.message}`);
                                                }
                                            })();
                                        });
                                    } else {
                                        // Verifica horário e status do chatbot antes de enviar mensagem de seleção inválida
                                        db.get('SELECT start_time, end_time, chatbot_enabled FROM connections WHERE id = ?', [id], (connErr, connRow) => {
                                            if (connErr) {
                                                logger.warn(`Erro ao buscar horários da conexão ${id}: ${connErr.message}`);
                                                return;
                                            }
                                            
                                            // Verifica se o chatbot está habilitado
                                            if (!connRow || connRow.chatbot_enabled !== 1) {
                                                logger.info(`[WA auto-message] Chatbot desabilitado para conexão ${id}. Não enviando mensagem de escolha inválida para ${contactNumber}.`);
                                                return;
                                            }
                                            
                                            // Verifica se está dentro do horário de funcionamento
                                            if (connRow && connRow.start_time && connRow.end_time) {
                                                if (!isWithinBusinessHours(connRow.start_time, connRow.end_time)) {
                                                    logger.info(`[WA auto-message] Fora do horário de funcionamento (${connRow.start_time} - ${connRow.end_time}). Não enviando mensagem de escolha inválida para ${contactNumber}.`);
                                                    return;
                                                }
                                            }
                                            
                                            // Envia a mensagem de seleção inválida padrão (somente se mensagem inicial já foi enviada)
                                            db.get('SELECT invalid_selection_message FROM chatbot_config ORDER BY id DESC LIMIT 1', (cfgErr, cfgRow) => {
                                                const reply = (cfgRow && cfgRow.invalid_selection_message) ? cfgRow.invalid_selection_message : `🤖 *Robô I Automático* 💬\n\nDesculpe, não entendi sua escolha.\nInforme *o número Ex:(1,2 ou 3...)*\n\nPara que possamos direcionar seu atendimento corretamente.`;
                                                (async () => {
                                                    try {
                                                        const contactId = `${contactNumber}@c.us`;
                                                        if (client && pendingRecord.initial_sent) {
                                                            try {
                                                                await client.sendMessage(contactId, reply);
                                                        } catch (sendErr) {
                                                            logger.error(`Erro ao enviar mensagem de escolha inválida via WhatsApp para ${contactNumber}: ${sendErr.message}`);
                                                        }
                                                    } else {
                                                            logger.warn(`Condição não atendida para envio de escolha inválida (client indisponível ou initial_sent=0) para ${contactNumber}`);
                                                    }
                                                } catch (e) {
                                                    logger.error(`Erro ao processar escolha inválida para ${contactNumber}: ${e.message}`);
                                                }
                                            })();
                                            });
                                        });
                                    }
                                }
                            });
                        } else {
                            // Não há registro pendente - precisa criar um novo
                            // Verifica cooldown antes de criar
                            logger.info(`[WA inbound] Verificando cooldown do bot para ${contactNumber}...`);
                            
                            db.get('SELECT cooldown_until FROM bot_cooldown WHERE contact_number = ?', [contactNumber], (cooldownErr, cooldownRow) => {
                                if (cooldownErr) {
                                    logger.warn(`Erro ao verificar cooldown para ${contactNumber}: ${cooldownErr.message}`);
                                }
                                
                                const now = new Date();
                                let isInCooldown = false;
                                
                                if (cooldownRow && cooldownRow.cooldown_until) {
                                    const cooldownUntil = new Date(cooldownRow.cooldown_until);
                                    if (now < cooldownUntil) {
                                        isInCooldown = true;
                                        const remainingMinutes = Math.ceil((cooldownUntil - now) / 60000);
                                        logger.info(`[WA inbound] Contato ${contactNumber} está em cooldown. Aguardar ${remainingMinutes} minuto(s).`);
                                    } else {
                                        // Cooldown expirado, remove da tabela
                                        db.run('DELETE FROM bot_cooldown WHERE contact_number = ?', [contactNumber], (delErr) => {
                                            if (delErr) logger.warn(`Erro ao remover cooldown expirado: ${delErr.message}`);
                                        });
                                    }
                                }
                                
                                if (isInCooldown) {
                                    // Bot está em cooldown - não cria registro nem envia mensagens automáticas
                                    logger.info(`[WA inbound] Bot em cooldown para ${contactNumber}. Aguardando término do período de espera.`);
                                    return;
                                }
                                
                                // Cooldown expirado ou inexistente - registra contato como pendente de seleção de fila
                                logger.info(`[WA inbound] Registrando ${contactNumber} como pendente de seleção de fila (conn ${id}).`);
                                
                                // Insere ou atualiza na tabela de pendentes
                                const insertPendingSql = `INSERT OR REPLACE INTO pending_queue_selection 
                                    (contact_number, contact_name, profile_pic_url, connection_id, first_message, first_message_timestamp, invalid_attempts) 
                                    VALUES (?, ?, ?, ?, ?, ?, 0)`;
                                
                                db.run(insertPendingSql, [contactNumber, contactName, profilePicUrl, id, messageBody, messageTime], function(err) {
                                    if (err) {
                                        logger.error(`Erro ao registrar contato pendente: ${err.message}`);
                                        return;
                                    }
                                    
                                    logger.info(`[WA inbound] Contato ${contactNumber} registrado como pendente de seleção.`);
                                        // Agenda lembrete e encerramento automático caso não seja selecionada a fila
                                        try {
                                            schedulePendingTimers(contactNumber, id);
                                        } catch (e) { logger.warn(`Falha ao agendar timers para ${contactNumber}: ${e.message}`); }
                                    
                                    // Enviar automaticamente a mensagem inicial e a lista de filas habilitadas
                                    try {
                                        // Busca a mensagem inicial configurada na conexão, horários e status do chatbot
                                        db.get('SELECT birthday_message, start_time, end_time, chatbot_enabled FROM connections WHERE id = ?', [id], (cErr, connRow) => {
                                            if (cErr) {
                                                logger.warn(`Não foi possível obter mensagem inicial da conexão ${id}: ${cErr.message}`);
                                                return;
                                            }

                                            // Verifica se o chatbot está habilitado
                                            if (!connRow || connRow.chatbot_enabled !== 1) {
                                                logger.info(`[WA auto-message] Chatbot desabilitado para conexão ${id}. Não enviando mensagens automáticas para ${contactNumber}.`);
                                                return;
                                            }

                                            // Verifica se está dentro do horário de funcionamento
                                            if (connRow && connRow.start_time && connRow.end_time) {
                                                if (!isWithinBusinessHours(connRow.start_time, connRow.end_time)) {
                                                    logger.info(`[WA auto-message] Fora do horário de funcionamento (${connRow.start_time} - ${connRow.end_time}). Não enviando mensagens automáticas para ${contactNumber}.`);
                                                    return;
                                                }
                                            }

                                            const initialMessage = connRow && connRow.birthday_message ? String(connRow.birthday_message).trim() : null;

                                            // Busca as filas habilitadas para esta conexão
                                            db.all(`SELECT q.name FROM connection_queues cq JOIN queues q ON cq.queue_id = q.id WHERE cq.connection_id = ? ORDER BY q.name ASC`, [id], async (qErr, qRows) => {
                                                if (qErr) {
                                                    logger.warn(`Não foi possível obter filas da conexão ${id}: ${qErr.message}`);
                                                }

                                                let queuesText = null;
                                                if (qRows && qRows.length > 0) {
                                                    queuesText = 'Por favor, informe *o número* da opção desejada - Ex:(1,2 ou 3...) ' + '\n\n---\n\n';
                                                    qRows.forEach((row, idx) => {
                                                        queuesText += `${idx + 1}. ${row.name}` + '\n';
                                                    });
                                                }

                                                // Envia as mensagens via WhatsApp (se cliente disponível) após 10 segundos
                                                setTimeout(async () => {
                                                    try {
                                                        const contactId = `${contactNumber}@c.us`;
                                                        logger.info(`[WA auto-message] Preparando envio automático para contato pendente ${contactNumber} (conn: ${id}). Cliente presente: ${client ? 'sim' : 'não'}`);

                                                        if (!client) {
                                                            logger.warn(`[WA auto-message] Cliente WhatsApp não disponível para conexão ${id}. Pulando envios automáticos para ${contactNumber}.`);
                                                            return;
                                                        }

                                                        // Verifica estado do client antes de enviar para evitar erros silenciosos
                                                        let clientState = null;
                                                        try {
                                                            clientState = await client.getState();
                                                            logger.info(`[WA auto-message] Estado do client para conn ${id}: ${clientState}`);
                                                        } catch (stateErr) {
                                                            logger.warn(`[WA auto-message] Não foi possível obter estado do client para conn ${id}: ${stateErr.message}`);
                                                        }

                                                        if (clientState !== 'CONNECTED') {
                                                            logger.warn(`[WA auto-message] Client não está conectado (estado=${clientState}). Não será enviada a mensagem automática para ${contactNumber}.`);
                                                            return;
                                                        }

                                                        // Envia mensagem inicial primeiro (se configurada)
                                                        if (initialMessage && initialMessage.length > 0) {
                                                            try {
                                                                logger.info(`[WA auto-message] Enviando mensagem inicial para ${contactNumber}`);
                                                                await client.sendMessage(contactId, initialMessage);
                                                            } catch (sendErr) {
                                                                logger.error(`[WA auto-message] Erro ao enviar mensagem inicial para ${contactNumber}: ${sendErr.message}`);
                                                            }
                                                        }

                                                        // Em seguida, envia a lista de filas (se houver)
                                                        if (queuesText) {
                                                            try {
                                                                logger.info(`[WA auto-message] Enviando lista de filas para ${contactNumber}`);
                                                                await client.sendMessage(contactId, queuesText);
                                                            } catch (sendErr2) {
                                                                logger.error(`[WA auto-message] Erro ao enviar lista de filas para ${contactNumber}: ${sendErr2.message}`);
                                                            }
                                                        }
                                                    } catch (outerErr) {
                                                        logger.error(`[WA auto-message] Erro inesperado ao processar mensagens automáticas para ${contactNumber}: ${outerErr.message}`);
                                                    } finally {
                                                        // Marca que a mensagem inicial foi enviada (ou tentativa feita)
                                                        db.run('UPDATE pending_queue_selection SET initial_sent = 1 WHERE contact_number = ? AND connection_id = ?', [contactNumber, id], (updErr) => {
                                                            if (updErr) logger.warn(`Erro ao marcar initial_sent para ${contactNumber}: ${updErr.message}`);
                                                        });
                                                    }
                                                }, 15000); // Aguarda 15 segundos antes de enviar
                                            });
                                        });
                                    } catch (ex) {
                                        logger.error(`Erro ao agendar mensagens automáticas para ${contactNumber}: ${ex.message}`);
                                    }
                                });
                            });
                        }
                    });
                    return; // Não continua processamento se não houver ticket
                }

                // Descobre a fila padrão associada a esta conexão (se houver)
                const qSql = 'SELECT queue_id FROM connection_queues WHERE connection_id = ? ORDER BY rowid ASC';
                db.all(qSql, [id], (qErr, qRows) => {
                    if (qErr) {
                        logger.warn(`Não foi possível obter filas para a conexão ${id}: ${qErr.message}`);
                    }
                    const defaultQueueId = qRows && qRows.length > 0 ? qRows[0].queue_id : null;

                    if (ticket) {
                        // Ticket ativo encontrado - adiciona mensagem ao ticket existente
                        // Salva a mensagem recebida
                        db.run('INSERT INTO messages (ticket_id, body, sender, timestamp) VALUES (?, ?, ?, ?)', 
                            [ticket.id, messageBody, 'contact', messageTime], 
                            function(err) {
                                if (err) {
                                    logger.error(`Erro ao salvar mensagem: ${err.message}`);
                                } else {
                                    // Emite evento de nova mensagem COM queue_id e user_id para filtros no frontend
                                    io.emit('new-message', {
                                        id: this.lastID,
                                        ticket_id: ticket.id,
                                        body: messageBody,
                                        sender: 'contact',
                                        timestamp: messageTime,
                                        queue_id: ticket.queue_id || null,
                                        user_id: ticket.user_id || null
                                    });
                                }
                            }
                        );

                        // --- Verifica se a mensagem do contato é uma escolha de fila (apenas números) ---
                        // MAS SÓ SE O TICKET AINDA NÃO TIVER UMA FILA ATRIBUÍDA
                        if (!ticket.queue_id) {
                            // Busca as filas associadas à conexão para mapear a escolha baseada na numeração
                            db.all(`SELECT q.id, q.name FROM connection_queues cq JOIN queues q ON cq.queue_id = q.id WHERE cq.connection_id = ? ORDER BY q.name ASC`, [id], (mapErr, mapRows) => {
                                if (mapErr) {
                                    logger.warn(`Erro ao buscar filas para mapear escolha do usuário: ${mapErr.message}`);
                                    return;
                                }

                                if (!mapRows || mapRows.length === 0) return; // sem filas para escolher

                                // Extrai o primeiro token da mensagem e tenta interpretar como número
                                const token = (messageBody || '').trim().split(/\s+/)[0];
                                const choice = parseInt(token, 10);
                                if (!isNaN(choice) && choice >= 1 && choice <= mapRows.length) {
                                const chosen = mapRows[choice - 1];

                                // Atualiza o ticket com a fila escolhida
                                db.run('UPDATE tickets SET queue_id = ?, status = ?, unread_messages = unread_messages + 1, invalid_choice_attempts = 0 WHERE id = ?', [chosen.id, 'pending', ticket.id], function(updateErr) {
                                    if (updateErr) {
                                        logger.warn(`Erro ao atualizar ticket ${ticket.id} com fila escolhida: ${updateErr.message}`);
                                    } else {
                                        logger.info(`Ticket ${ticket.id} atualizado para fila ${chosen.name} (id=${chosen.id}) a partir da escolha do usuário.`);
                                        // Após definir a fila, tentar atribuir automaticamente a um agente daquela fila
                                        db.get(`
                                            SELECT u.id AS user_id, MAX(s.last_activity) AS last_activity
                                            FROM users u
                                            INNER JOIN user_queues uq ON u.id = uq.user_id
                                            LEFT JOIN user_sessions s ON u.id = s.user_id
                                            WHERE uq.queue_id = ?
                                            GROUP BY u.id
                                            ORDER BY last_activity DESC
                                            LIMIT 1
                                        `, [chosen.id], (agentErr, agentRow) => {
                                            if (agentErr) {
                                                logger.warn(`Erro ao buscar agente para fila ${chosen.id}: ${agentErr.message}`);
                                                io.emit('ticket_update', { id: ticket.id, status: 'pending', queue_id: chosen.id });
                                                return;
                                            }

                                            if (agentRow && agentRow.user_id) {
                                                db.run('UPDATE tickets SET user_id = ? WHERE id = ?', [agentRow.user_id, ticket.id], function(assignErr) {
                                                    if (assignErr) {
                                                        logger.warn(`Erro ao atribuir ticket ${ticket.id} ao agente ${agentRow.user_id}: ${assignErr.message}`);
                                                        io.emit('ticket_update', { id: ticket.id, status: 'pending', queue_id: chosen.id });
                                                    } else {
                                                        logger.info(`Ticket ${ticket.id} atribuído automaticamente ao agente ${agentRow.user_id}`);
                                                        io.emit('ticket_update', { id: ticket.id, status: 'pending', queue_id: chosen.id, user_id: agentRow.user_id });
                                                    }
                                                });
                                            } else {
                                                // Nenhum agente encontrado - apenas notifica mudança de fila
                                                io.emit('ticket_update', { id: ticket.id, status: 'pending', queue_id: chosen.id });
                                            }
                                        });
                                    }
                                });

                                // Envia a mensagem de confirmação ao usuário via WhatsApp (se cliente disponível)
                                (async () => {
                                    try {
                                        const contactId = `${contactNumber}@c.us`;
                                        if (client) {
                                            const confirmText = `👋 Perfeito!\nVocê selecionou o setor *${chosen.name}*.\n\n📄 Seu atendimento foi registrado com o protocolo nº *${ticket.protocol_number}*.\n\n💬 Um de nossos atendentes entrará em contato em breve.\n\nPara agilizar o seu atendimento, poderia adiantar alguns detalhes sobre o problema ou solicitação?`;
                                            try {
                                                await sendBotMessageIfUnassigned(client, contactId, ticket.id, confirmText);
                                            } catch (sendErr) {
                                                logger.error(`Erro ao enviar confirmação de fila via WhatsApp para ${contactNumber}: ${sendErr.message}`);
                                            }
                                        } else {
                                            logger.warn(`Cliente WhatsApp não disponível ao processar escolha de fila para ticket ${ticket.id}`);
                                        }
                                    } catch (e) {
                                        logger.error(`Erro inesperado ao processar escolha de fila para ticket ${ticket.id}: ${e.message}`);
                                    }
                                })();
                            } else {
                                // Entrada inválida (não-numérica ou número fora do intervalo)
                                // Incrementa contador de tentativas inválidas
                                db.run('UPDATE tickets SET invalid_choice_attempts = COALESCE(invalid_choice_attempts,0) + 1 WHERE id = ?', [ticket.id], function(incErr) {
                                    if (incErr) logger.warn(`Falha ao incrementar contador de tentativas inválidas para ticket ${ticket.id}: ${incErr.message}`);

                                    // Recupera o valor atualizado
                                    db.get('SELECT COALESCE(invalid_choice_attempts,0) AS attempts FROM tickets WHERE id = ?', [ticket.id], (aErr, aRow) => {
                                        const attempts = (aRow && aRow.attempts) ? aRow.attempts : 0;

                                        if (attempts >= 3) {
                                            // Verifica horário antes de enviar mensagem de encerramento
                                            db.get('SELECT start_time, end_time FROM connections WHERE id = ?', [id], (connErr, connRow) => {
                                                if (connErr) {
                                                    logger.warn(`Erro ao buscar horários da conexão ${id}: ${connErr.message}`);
                                                }
                                                
                                                // Verifica se está dentro do horário de funcionamento
                                                let shouldSendMessage = true;
                                                if (connRow && connRow.start_time && connRow.end_time) {
                                                    if (!isWithinBusinessHours(connRow.start_time, connRow.end_time)) {
                                                        logger.info(`[WA auto-message] Fora do horário de funcionamento (${connRow.start_time} - ${connRow.end_time}). Não enviando mensagem de encerramento para ticket ${ticket.id}.`);
                                                        shouldSendMessage = false;
                                                    }
                                                }
                                                
                                                // Envia mensagem de encerramento e marcar ticket como resolvido
                                                const closingMsg = `🤖 *Robô I Automático* 💬\n\n⚠ Não identificamos uma resposta válida.\n\nPara manter a qualidade e agilidade do nosso atendimento, esta conversa será encerrada automaticamente.\n\n💬 Caso ainda precise de suporte, basta enviar uma nova mensagem para iniciar um novo atendimento.`;
                                                (async () => {
                                                    try {
                                                        const contactId = `${contactNumber}@c.us`;
                                                        if (client && shouldSendMessage) {
                                                            try {
                                                                await sendBotMessageIfUnassigned(client, contactId, ticket.id, closingMsg);
                                                            } catch (sendErr) {
                                                                logger.error(`Erro ao enviar mensagem de encerramento via WhatsApp para ${contactNumber}: ${sendErr.message}`);
                                                            }
                                                        } else if (!shouldSendMessage) {
                                                            logger.info(`Mensagem de encerramento não enviada (fora do horário) para ticket ${ticket.id}`);
                                                        } else {
                                                            logger.warn(`Cliente WhatsApp não disponível ao enviar mensagem de encerramento para ticket ${ticket.id}`);
                                                        }

                                                        // Atualiza status do ticket para resolved
                                                        db.run("UPDATE tickets SET status = 'resolved', is_on_hold = 0 WHERE id = ?", [ticket.id], function(uErr) {
                                                            if (uErr) logger.warn(`Falha ao marcar ticket ${ticket.id} como resolvido: ${uErr.message}`);
                                                            else io.emit('ticket_update', { id: ticket.id, status: 'resolved' });
                                                        });
                                                    } catch (e) {
                                                        logger.error(`Erro ao processar encerramento por tentativas inválidas para ticket ${ticket.id}: ${e.message}`);
                                                    }
                                                })();
                                            });
                                        } else {
                                            // Verifica horário antes de enviar mensagem de seleção inválida
                                            db.get('SELECT start_time, end_time FROM connections WHERE id = ?', [id], (connErr, connRow) => {
                                                if (connErr) {
                                                    logger.warn(`Erro ao buscar horários da conexão ${id}: ${connErr.message}`);
                                                    return;
                                                }
                                                
                                                // Verifica se está dentro do horário de funcionamento
                                                if (connRow && connRow.start_time && connRow.end_time) {
                                                    if (!isWithinBusinessHours(connRow.start_time, connRow.end_time)) {
                                                        logger.info(`[WA auto-message] Fora do horário de funcionamento (${connRow.start_time} - ${connRow.end_time}). Não enviando mensagem de escolha inválida para ticket ${ticket.id}.`);
                                                        return;
                                                    }
                                                }
                                                
                                                // Envia a mensagem de seleção inválida padrão
                                                db.get('SELECT invalid_selection_message FROM chatbot_config ORDER BY id DESC LIMIT 1', (cfgErr, cfgRow) => {
                                                    const reply = (cfgRow && cfgRow.invalid_selection_message) ? cfgRow.invalid_selection_message : `🤖 *Robô I Automático* 💬\n\nDesculpe, não entendi sua escolha.\nInforme *o número Ex:(1,2 ou 3...)*\n\nPara que possamos direcionar seu atendimento corretamente.`;
                                                    (async () => {
                                                        try {
                                                            const contactId = `${contactNumber}@c.us`;
                                                            if (client) {
                                                                try {
                                                                    await sendBotMessageIfUnassigned(client, contactId, ticket.id, reply);
                                                            } catch (sendErr) {
                                                                logger.error(`Erro ao enviar mensagem de escolha inválida via WhatsApp para ${contactNumber}: ${sendErr.message}`);
                                                            }
                                                        } else {
                                                            logger.warn(`Cliente WhatsApp não disponível ao notificar escolha inválida para ticket ${ticket.id}`);
                                                        }
                                                    } catch (e) {
                                                        logger.error(`Erro ao processar escolha inválida para ticket ${ticket.id}: ${e.message}`);
                                                    }
                                                })();
                                                });
                                            });
                                        }
                                    });
                                });
                            }
                        });
                        } // Fecha o if (!ticket.queue_id)

                        const statusToUpdate = ticket.status === 'attending' ? 'attending' : 'pending';
                        const unreadIncrement = ticket.status === 'attending' ? 0 : 1;

                        // Atualiza ticket, preenchendo queue_id se estiver ausente
                        let updateSql = `UPDATE tickets SET last_message = ?, status = ?, unread_messages = unread_messages + ?, last_message_at = ?, profile_pic_url = ?, is_on_hold = 0`;
                        const updateParams = [messageBody, statusToUpdate, unreadIncrement, messageTime, profilePicUrl];
                        // Não aplicar queue_id padrão automaticamente — aguardamos a escolha do usuário no chatbot
                        updateSql += ` WHERE id = ?`;
                        updateParams.push(ticket.id);

                        db.run(updateSql, updateParams, function(err) {
                            if (!err) io.emit('ticket_update', { id: ticket.id, status: statusToUpdate });
                        });
                    }
                });
                
                
            });

            // Listener para ack/receipts de mensagens (quando a biblioteca os emitir)
            // ack: número indicando o nível (0=pending,1=server,2=delivered,3=read) — mapeamento aproximado
            try {
                // Remove any previous message_ack listeners on this client to avoid
                // accumulating multiple handlers when sessions are reinitialized.
                try {
                    if (typeof client.removeAllListeners === 'function') {
                        client.removeAllListeners('message_ack');
                    }
                } catch (remErr) {
                    logger.warn(`Falha ao limpar listeners anteriores de message_ack para sessao ${id}: ${remErr && remErr.message}`);
                }

                client.on('message_ack', (msgObj, ack) => {
                    try {
                        const waId = msgObj && msgObj.id && msgObj.id._serialized ? msgObj.id._serialized : null;
                        if (!waId) return;
                        // Considera ack >= 2 como 'delivered'
                        if (typeof ack === 'number' && ack >= 2) {
                            // Tenta marcar delivered apenas se ainda não estiver marcado (idempotente)
                            db.get('SELECT id, delivered FROM messages WHERE wa_message_id = ? LIMIT 1', [waId], (gErr, row) => {
                                if (gErr) return logger.warn(`Erro ao buscar mensagem por wa_message_id ${waId}: ${gErr.message}`);
                                if (!row) return; // não temos a mensagem no banco
                                if (row.delivered && parseInt(row.delivered, 10) === 1) return; // já marcado
                                db.run('UPDATE messages SET delivered = 1 WHERE id = ? AND (delivered IS NULL OR delivered != 1)', [row.id], function(uErr) {
                                    if (uErr) return logger.warn(`Falha ao marcar mensagem ${row.id} como delivered: ${uErr.message}`);
                                    if (this && this.changes && this.changes > 0) {
                                        logger.info(`Mensagem ${row.id} marcada como delivered (wa_id=${waId}, ack=${ack})`);
                                        // Notifica frontends conectados sobre a atualização
                                        io.emit('message_update', { id: row.id, delivered: 1 });
                                    }
                                });
                            });
                        }
                    } catch (e) {
                        logger.warn('Erro no handler message_ack:', e && e.message ? e.message : e);
                    }
                });
            } catch (e) {
                // se a biblioteca não suportar esse evento, apenas logamos e seguimos
                logger.debug('Evento message_ack não suportado nesta versão da biblioteca ou falha ao registrar listener.');
            }
        });
    });

    client.on('disconnected', async (reason) => {
        logger.warn(`Sessão ${id} desconectada: ${reason}`);
        db.run('UPDATE connections SET status = ?, last_updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['DISCONNECTED', id], (err) => {
            if (!err) io.emit('connection_update', { id: id, status: 'DISCONNECTED' });
        });
        // Remove a sessão do gerenciador
        delete sessions[clientId];
        // limpa flag de inicialização caso esteja setada
        initializing[clientId] = false;
        // conta como falha para controlar retries
        failCounts[clientId] = (failCounts[clientId] || 0) + 1;
        lastFail[clientId] = Date.now();
        clearTimeout(initTimeout);
        // Tenta destruir a instância do cliente para limpar recursos
        try {
            await client.destroy();
            logger.info(`Cliente da sessão ${id} destruído após desconexão.`);
        } catch (e) {
            logger.warn(`Aviso ao destruir cliente da sessão ${id}: ${e.message}`);
        }
    });

    // Usar 'on' em vez de 'once' para o QR code.
    // O evento 'qr' pode ser emitido mais de uma vez em certas condições.
    // O listener será removido manualmente quando a conexão for estabelecida ou falhar.
    const qrListener = (qr) => {
        logger.info(`QR recebido para a sessão ${id}, enviando via WebSocket.`);
        db.run('UPDATE connections SET status = ?, last_updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['QR_PENDING', id], (err) => {
            if (!err) io.emit('connection_update', { id: id, status: 'QR_PENDING' });
        });
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                logger.error(`Erro ao gerar QR Code para Data URL: ${err}`);
            } else {
                // Em vez de emitir via WebSocket, armazenamos o QR Code para polling
                qrStore[id] = url;
            }
        });
    };
    client.on('qr', qrListener);

    try {
        await client.initialize();
        // A inicialização começou. O resultado será tratado pelos eventos 'ready', 'qr' ou o timeout.
        if (res) res.status(202).json({ message: "Inicialização da conexão em andamento." });
    } catch (error) {
        logger.error(`Falha ao inicializar ou gerar QR para a sessão ${id}: ${error.message}`);
        // Se a inicialização falhar, remove a sessão do gerenciador
        delete sessions[clientId];
        client.removeListener('qr', qrListener); // Limpa o listener em caso de erro
        initializing[clientId] = false;
        failCounts[clientId] = (failCounts[clientId] || 0) + 1;
        lastFail[clientId] = Date.now();
        clearTimeout(initTimeout);
        if (res && !res.headersSent) {
            res.status(500).json({ message: error.message || "Falha ao iniciar a conexão." });
        }
    }
}

// Rota que chama a função de inicialização
app.post('/api/connections/:id/init', (req, res) => initializeConnection(req.params.id, res));

// Rota para o frontend fazer polling e buscar o QR Code
app.get('/api/connections/:id/qr', (req, res) => {
    const { id } = req.params;
    if (qrStore[id]) {
        const data = qrStore[id];
        // NÃO deletar o QR code aqui - ele deve permanecer até ser autenticado ou expirar
        // delete qrStore[id]; // REMOVIDO - permite múltiplas requisições do mesmo QR

        if (data.error) {
            return res.status(500).json({ message: data.error });
        }
        
        res.status(200).json({ qrUrl: data });
    } else {
        res.status(202).json({ message: 'QR Code ainda não está pronto.' }); // 202 Accepted (mas não pronto)
    }
});

// Rota para desconectar uma sessão manualmente
app.post('/api/connections/:id/disconnect', async (req, res) => {
    const { id } = req.params;
    const clientId = String(id);
    const client = sessions[clientId];

    if (client) {
        logger.info(`Iniciando desconexão manual para a sessão ${id}.`);
        try {
            // O logout pode falhar se a sessão já estiver instável.
            // O importante é garantir a destruição e limpeza.
            await client.logout().catch(e => logger.warn(`Erro no logout (ignorado): ${e.message}`));
        } catch (e) {
            logger.warn(`Erro durante o client.logout() para a sessão ${id} (pode ser normal se a conexão já caiu): ${e.message}`);
        } finally {
            // Independentemente do resultado do logout, força a destruição e limpeza.
            // O evento 'disconnected' pode não ser acionado se o cliente já estiver em um estado inválido.
            try {
                await client.destroy();
                logger.info(`Cliente da sessão ${id} destruído com sucesso.`);
            } catch (e) {
                logger.error(`Erro ao destruir o cliente da sessão ${id} na desconexão manual: ${e.message}`);
            }
            delete sessions[clientId];
            delete qrStore[id]; // Limpa qualquer QR code pendente para esta sessão
            db.run('UPDATE connections SET status = ?, last_updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['DISCONNECTED', id], (err) => {
                if (!err) io.emit('connection_update', { id: id, status: 'DISCONNECTED' });
            });
            res.status(200).json({ message: "Sessão desconectada com sucesso." });
        }
    } else {
        res.status(404).json({ message: "Sessão não encontrada ou não está ativa." });
    }
});

// Rota para abortar a inicialização de uma conexão (quando o usuário fecha o modal do QR)
app.post('/api/connections/:id/abort', async (req, res) => {
    const { id } = req.params;
    const clientId = String(id);
    const client = sessions[clientId];

    if (client) {
        logger.info(`Abortando inicialização da sessão ${id} a pedido do cliente.`);
        try {
            // Tenta destruir o cliente para liberar os recursos do puppeteer
            await client.destroy();
            logger.info(`Cliente da sessão ${id} destruído com sucesso após abortar.`);
        } catch (e) {
            logger.error(`Erro ao destruir cliente da sessão ${id} ao abortar: ${e.message}`);
        } finally {
            // Garante que a sessão seja removida da memória
            delete sessions[clientId];
        }
    }
    res.status(200).json({ message: "Inicialização abortada." });
});

// GET Dashboard Stats
app.get('/api/dashboard/stats', (req, res) => {
    // Opcional: aceita token de sessão via query ou header
    const sessionToken = req.query.sessionToken || req.headers['x-session-token'];

    // Filtros opcionais
    const dateStart = (req.query.dateStart || '').trim(); // YYYY-MM-DD
    const dateEnd = (req.query.dateEnd || '').trim();   // YYYY-MM-DD
    const userIdFilter = req.query.userId ? parseInt(req.query.userId, 10) : null;

    // Monta cláusulas WHERE dinamicamente
    const wherePartsBase = [];
    const paramsBase = [];
    if (userIdFilter) {
        wherePartsBase.push('user_id = ?');
        paramsBase.push(userIdFilter);
    }
    // Aplica range opcional para atendendo/pendente
    if (dateStart && dateEnd) {
        wherePartsBase.push("date(last_message_at, 'localtime') >= date(?)");
        paramsBase.push(dateStart);
        wherePartsBase.push("date(last_message_at, 'localtime') <= date(?)");
        paramsBase.push(dateEnd);
    } else if (dateStart && !dateEnd) {
        wherePartsBase.push("date(last_message_at, 'localtime') = date(?)");
        paramsBase.push(dateStart);
    } else if (!dateStart && dateEnd) {
        wherePartsBase.push("date(last_message_at, 'localtime') = date(?)");
        paramsBase.push(dateEnd);
    }
    const whereBase = wherePartsBase.length ? (' AND ' + wherePartsBase.join(' AND ')) : '';

    // Contadores: atendendo e pendente
    const attSql = `SELECT COUNT(*) AS cnt FROM tickets WHERE status = 'attending'${whereBase}`;
    db.get(attSql, paramsBase, (err, rowAtt) => {
        if (err) return res.status(500).json({ error: err.message });
        const attendingCount = rowAtt ? rowAtt.cnt : 0;

        const pendSql = `SELECT COUNT(*) AS cnt FROM tickets WHERE status = 'pending'${whereBase}`;
        db.get(pendSql, paramsBase, (err2, rowPend) => {
            if (err2) return res.status(500).json({ error: err2.message });
            const pendingCount = rowPend ? rowPend.cnt : 0;

            // Tickets resolvidos no dia filtrado (ou hoje se não informado)
            const resWhereParts = ["status = 'resolved'"];
            const resParams = [];
            if (userIdFilter) { resWhereParts.push('user_id = ?'); resParams.push(userIdFilter); }
            // Para resolved e gráfico: se nenhum período for informado, usa hoje; se houver start/end, aplica o range
            if (dateStart && dateEnd) {
                resWhereParts.push("date(last_message_at, 'localtime') >= date(?)"); resParams.push(dateStart);
                resWhereParts.push("date(last_message_at, 'localtime') <= date(?)"); resParams.push(dateEnd);
            } else if (dateStart && !dateEnd) {
                resWhereParts.push("date(last_message_at, 'localtime') = date(?)"); resParams.push(dateStart);
            } else if (!dateStart && dateEnd) {
                resWhereParts.push("date(last_message_at, 'localtime') = date(?)"); resParams.push(dateEnd);
            } else {
                resWhereParts.push("date(last_message_at, 'localtime') = date('now','localtime')");
            }
            const resolvedSql = `SELECT COUNT(*) AS cnt FROM tickets WHERE ${resWhereParts.join(' AND ')}`;

            db.get(resolvedSql, resParams, (err3, rowRes) => {
                if (err3) return res.status(500).json({ error: err3.message });
                const resolvedTodayCount = rowRes ? rowRes.cnt : 0;

                // Dados do gráfico por período do dia (aplica mesmos filtros de resolved)
                const periodFilter = resWhereParts.join(' AND ');
                const mSql = `SELECT COUNT(*) AS cnt FROM tickets WHERE ${periodFilter} AND CAST(strftime('%H', last_message_at) AS INTEGER) BETWEEN 6 AND 11`;
                const aSql = `SELECT COUNT(*) AS cnt FROM tickets WHERE ${periodFilter} AND CAST(strftime('%H', last_message_at) AS INTEGER) BETWEEN 12 AND 17`;
                const nSql = `SELECT COUNT(*) AS cnt FROM tickets WHERE ${periodFilter} AND (CAST(strftime('%H', last_message_at) AS INTEGER) >= 18 OR CAST(strftime('%H', last_message_at) AS INTEGER) <= 5)`;

                db.get(mSql, resParams, (mErr, mRow) => {
                    if (mErr) return res.status(500).json({ error: mErr.message });
                    const morning = mRow ? mRow.cnt : 0;
                    db.get(aSql, resParams, (aErr, aRow) => {
                        if (aErr) return res.status(500).json({ error: aErr.message });
                        const afternoon = aRow ? aRow.cnt : 0;
                        db.get(nSql, resParams, (nErr, nRow) => {
                            if (nErr) return res.status(500).json({ error: nErr.message });
                            const night = nRow ? nRow.cnt : 0;

                            return res.json({
                                attendingCount,
                                pendingCount,
                                resolvedTodayCount,
                                chartData: [morning, afternoon, night]
                            });
                        });
                    });
                });
            });
        });
    });
});

// Rota existente: atualiza status do ticket
app.put('/api/tickets/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, on_hold, user_id, queue_id, sessionToken } = req.body;

    if (!status) {
        return res.status(400).json({ error: "O status é obrigatório." });
    }

    try {
        // Resolve acting user from sessionToken, if fornecido
        let actingUserId = null;
        if (sessionToken) {
            actingUserId = await new Promise((resolve, reject) => {
                db.get('SELECT user_id FROM user_sessions WHERE session_token = ?', [sessionToken], (err, row) => {
                    if (err) return reject(err);
                    resolve(row ? row.user_id : null);
                });
            });

            if (!actingUserId) {
                return res.status(401).json({ error: 'Sessão inválida.' });
            }
        }

        // Normalize acting user: prefer sessionToken resolved user, fallback to provided user_id in body or query
        let acting = actingUserId || req.body.user_id || user_id || null;

        // If accepting a ticket (status -> 'attending'), enforce strict queue membership rules
        if (status === 'attending') {
            if (!acting) {
                return res.status(401).json({ error: 'Sessão inválida ou usuário não informado para aceitar o ticket.' });
            }

            // Fetch current ticket
            const ticket = await new Promise((resolve, reject) => {
                db.get('SELECT id, user_id, queue_id, status FROM tickets WHERE id = ?', [id], (err, row) => {
                    if (err) return reject(err);
                    resolve(row || null);
                });
            });

            if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado.' });

            // Pre-compute whether acting user belongs to the ticket's queue (if any)
            let belongsToQueue = false;
            if (ticket.queue_id) {
                belongsToQueue = await new Promise((resolve, reject) => {
                    db.get('SELECT 1 FROM user_queues WHERE user_id = ? AND queue_id = ? LIMIT 1', [acting, ticket.queue_id], (err, row) => {
                        if (err) return reject(err);
                        resolve(!!row);
                    });
                });
            }

            // If the ticket is already assigned to another user, disallow —
            // EXCEPT when the ticket is in 'pending' (aguardando) and the acting user
            // belongs to the same queue. Nesse caso permitimos que qualquer agente da
            // fila aceite o ticket (comportamento solicitado).
            if (ticket.user_id && ticket.user_id !== acting) {
                if (!(ticket.status === 'pending' && ticket.queue_id && belongsToQueue)) {
                    return res.status(409).json({ error: 'Ticket já foi aceito por outro agente.' });
                } else {
                    logger.info(`Agent ${acting} pertence à fila ${ticket.queue_id} e está assumindo o ticket ${id} em pending (override permitido).`);
                }
            }

            // If the ticket has a queue_id, ensure acting user belongs to that queue
            if (ticket.queue_id) {
                if (!belongsToQueue) {
                    return res.status(403).json({ error: 'Agente não pertence à fila deste ticket.' });
                }
            } else {
                // If ticket has no queue, attempt to assign the agent's primary queue to the ticket
                const agentQueue = await new Promise((resolve, reject) => {
                    db.get('SELECT queue_id FROM user_queues WHERE user_id = ? ORDER BY rowid ASC LIMIT 1', [acting], (err, row) => {
                        if (err) return reject(err);
                        resolve(row ? row.queue_id : null);
                    });
                });

                if (agentQueue) {
                    // inject queue_id so the UPDATE below will persist it
                    req.body.queue_id = agentQueue;
                } else {
                    // Agent has no queue -> cannot accept a ticket without queue
                    return res.status(403).json({ error: 'Agente não possui fila atribuída; não é possível aceitar este ticket.' });
                }
            }

            // Force the update to set this acting user as the ticket owner
            req.body.user_id = acting;
        }

        // Build update SQL (preserving previous behavior)
        let sql = 'UPDATE tickets SET status = ?, unread_messages = 0';
        const params = [status];

        if (typeof on_hold !== 'undefined') {
            sql += ', is_on_hold = ?';
            params.push(on_hold ? 1 : 0);
        } else if (status === 'attending') {
            sql += ', is_on_hold = 0';
        }

        // user_id may have been injected above
        const finalUserId = req.body.user_id || user_id;
        if (finalUserId) {
            sql += ', user_id = ?';
            params.push(finalUserId);
        }

        if (queue_id) {
            sql += ', queue_id = ?';
            params.push(queue_id);
        }

        sql += ' WHERE id = ?';
        params.push(id);

        await new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if (err) return reject(err);
                resolve(this.changes);
            });
        });

    logger.info(`Ticket ${id} atualizado -> status=${status} user_id=${finalUserId || 'N/A'} queue_id=${queue_id || 'N/A'} on_hold=${typeof on_hold !== 'undefined' ? on_hold : '(mantido ou reset se attending)'}`);

        // Emit update including assigned user when available
        const emitPayload = { id: id, status: status };
        if (finalUserId) emitPayload.user_id = finalUserId;
        io.emit('ticket_update', emitPayload);

        // Quando um agente assume o atendimento (status -> 'attending'), limpa timers automáticos pendentes
        if (status === 'attending') {
            db.get('SELECT contact_number FROM tickets WHERE id = ?', [id], (err, ticketRow) => {
                if (!err && ticketRow) {
                    clearPendingTimers(ticketRow.contact_number);
                }
            });
        }

        // Se status for 'resolved', enviar mensagem de despedida pelo Bot
        if (status === 'resolved') {
            (async () => {
                try {
                    // Busca contato e possível connection_id do ticket
                    const ticketRow = await new Promise((resolve, reject) => {
                        db.get('SELECT contact_number, connection_id, is_manual FROM tickets WHERE id = ?', [id], (err, row) => {
                            if (err) return reject(err);
                            resolve(row || null);
                        });
                    });

                    if (!ticketRow) {
                        logger.warn(`Ao enviar despedida: ticket ${id} não encontrado.`);
                        return;
                    }

                    // NÃO enviar despedida para tickets marcados como manuais
                    if (ticketRow.is_manual === 1) {
                        logger.info(`Skip despedida: ticket ${id} resolvido é manual (is_manual=1). Nenhuma mensagem de bot será enviada.`);
                        return;
                    }

                    // Determina cliente WhatsApp a usar
                    let client = null;
                    let usedConnectionId = ticketRow.connection_id;
                    if (ticketRow.connection_id) {
                        client = sessions[String(ticketRow.connection_id)];
                    }

                    if (!client) {
                        const activeConnections = Object.keys(sessions).filter(sessionId => {
                            const session = sessions[sessionId];
                            return session && session.info && session.info.wid;
                        });
                        if (activeConnections.length > 0) {
                            usedConnectionId = activeConnections[0];
                            client = sessions[usedConnectionId];
                            logger.info(`Ao enviar despedida: usando conexão ativa ${usedConnectionId} para ticket ${id}`);
                        }
                    }

                    // Se a conexão usada existir, verificar se a flag is_default está habilitada.
                    // Se is_default estiver desabilitado, pulamos qualquer envio de mensagem automática do bot.
                    let farewell = null;
                    if (usedConnectionId) {
                        try {
                            const connCfg = await new Promise((resolve) => {
                                db.get('SELECT is_default, farewell_message FROM connections WHERE id = ?', [usedConnectionId], (cErr, cRow) => {
                                    resolve(cRow || null);
                                });
                            });

                            if (connCfg && (connCfg.is_default === 0 || connCfg.is_default === '0' || connCfg.is_default === null)) {
                                logger.info(`Connection ${usedConnectionId} has is_default disabled; skipping bot farewell for ticket ${id}`);
                                // Não enviar nem salvar a mensagem de despedida quando a conexão não for padrão
                                return;
                            }

                            if (connCfg && connCfg.farewell_message) farewell = String(connCfg.farewell_message).trim();
                        } catch (e) {
                            logger.warn(`Erro ao ler farewell_message da conexão ${usedConnectionId}: ${e && e.message}`);
                        }
                    }

                    if (!farewell) {
                        try {
                            const cfgRow = await new Promise((resolve) => {
                                db.get('SELECT thank_you_message FROM chatbot_config ORDER BY id DESC LIMIT 1', (cfgErr, cfg) => {
                                    resolve(cfg || null);
                                });
                            });
                            if (cfgRow && cfgRow.thank_you_message) farewell = cfgRow.thank_you_message;
                        } catch (e) {
                            logger.warn('Erro ao ler thank_you_message de chatbot_config: ' + (e && e.message));
                        }
                    }

                    if (!farewell) farewell = 'Obrigado! Caso precise de mais suporte, envie uma nova mensagem para reabrir o atendimento.';

                    const contactId = `${ticketRow.contact_number}@c.us`;

                    // Se não houver cliente, ainda registramos a mensagem localmente
                    if (!client) {
                        logger.warn(`Nenhuma sessão WhatsApp disponível para enviar despedida do ticket ${id}; salvando mensagem localmente.`);
                        const sentAt = getLocalDateTime();
                        db.run('INSERT INTO messages (ticket_id, body, sender, timestamp) VALUES (?, ?, ?, ?)', [id, farewell, 'bot', sentAt], function(saveErr) {
                            if (saveErr) logger.warn(`Falha ao salvar mensagem de despedida para ticket ${id}: ${saveErr.message}`);
                            else io.emit('new-message', { id: this.lastID, ticket_id: id, body: farewell, sender: 'bot', timestamp: sentAt });
                        });
                        return;
                    }

                    // Tenta enviar via WhatsApp e registrar
                    try {
                        const waMsg = await safeSendMessage(client, contactId, farewell);
                        const waId = waMsg && waMsg.id && waMsg.id._serialized ? waMsg.id._serialized : null;
                        const sentAt = getLocalDateTime();
                        db.run('INSERT INTO messages (ticket_id, body, sender, timestamp, sent_via_whatsapp, wa_message_id, delivered) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, farewell, 'bot', sentAt, 1, waId, 0], function(saveErr) {
                            if (saveErr) logger.warn(`Falha ao salvar mensagem de despedida para ticket ${id}: ${saveErr.message}`);
                            else io.emit('new-message', { id: this.lastID, ticket_id: id, body: farewell, sender: 'bot', timestamp: sentAt, sent_via_whatsapp: 1, wa_message_id: waId, delivered: 0 });
                        });
                        logger.info(`Mensagem de despedida enviada para ticket ${id} (contato ${ticketRow.contact_number}).`);
                        
                        // Adiciona cooldown de 1 minuto para o bot após enviar mensagem de despedida
                        const cooldownUntil = new Date(Date.now() + 1 * 60 * 1000).toISOString(); // 1 minuto
                        db.run('INSERT OR REPLACE INTO bot_cooldown (contact_number, cooldown_until) VALUES (?, ?)', 
                            [ticketRow.contact_number, cooldownUntil], 
                            (cooldownErr) => {
                                if (cooldownErr) {
                                    logger.warn(`Falha ao registrar cooldown do bot para contato ${ticketRow.contact_number}: ${cooldownErr.message}`);
                                } else {
                                    logger.info(`Cooldown de 1 minuto ativado para contato ${ticketRow.contact_number} até ${cooldownUntil}`);
                                }
                            }
                        );
                    } catch (sendErr) {
                        logger.error(`Erro ao enviar mensagem de despedida via WhatsApp para ticket ${id}: ${sendErr && sendErr.message}`);
                        // Ainda salva localmente para histórico (marcada como não enviada via WA)
                        const sentAt = getLocalDateTime();
                        db.run('INSERT INTO messages (ticket_id, body, sender, timestamp) VALUES (?, ?, ?, ?)', [id, farewell, 'bot', sentAt], function(saveErr) {
                            if (saveErr) logger.warn(`Falha ao salvar mensagem de despedida após erro de envio para ticket ${id}: ${saveErr.message}`);
                            else io.emit('new-message', { id: this.lastID, ticket_id: id, body: farewell, sender: 'bot', timestamp: sentAt });
                        });
                    }
                } catch (e) {
                    logger.error(`Erro inesperado ao processar mensagem de despedida para ticket ${id}: ${e && e.message}`);
                }
            })();
        }

        return res.json({ message: "Status do ticket atualizado com sucesso." });
    } catch (err) {
        logger.error(`Erro ao atualizar status do ticket ${req.params.id}: ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
});
// GET all tickets (filtrado por usuário e fila)
app.get('/api/tickets', (req, res) => {
    const status = req.query.status || 'pending';
    const onHold = req.query.on_hold; // '0' ou '1'
    const sessionToken = req.query.sessionToken || req.headers['x-session-token'];
    const userIdParam = req.query.user_id; // fallback (menos seguro)
    const queueIds = req.query.queue_ids; // IDs das filas do usuário (separados por vírgula)
    
    let sql = "SELECT * FROM tickets WHERE status = ?";
    const params = [status];
    
    // Filtro por on_hold
    if (onHold === '0' || onHold === '1') {
        sql += " AND is_on_hold = ?";
        params.push(parseInt(onHold, 10));
    }

    function runQueryWithResolvedUser(resolvedUserId) {
        const effectiveUserId = resolvedUserId || userIdParam;

        if (effectiveUserId) {
            // Resolve profile first
            db.get('SELECT profile FROM users WHERE id = ?', [effectiveUserId], (err, user) => {
                if (err) return res.status(500).json({ error: err.message });
                const profileValue = user && user.profile ? String(user.profile).toLowerCase() : '';
                const isAdmin = profileValue === 'admin' || profileValue === 'administrador';

                if (isAdmin) {
                    // Administradores veem tudo (com filtros aplicados acima)
                    sql += " ORDER BY last_message_at DESC";
                    db.all(sql, params, (err, rows) => {
                        if (err) return res.status(500).json({ error: err.message });
                        const formattedRows = rows.map(ticket => ({ ...ticket, formatted_last_message_time: formatLastMessageTime(ticket.last_message_at) }));
                        res.json(formattedRows);
                    });
                    return;
                }

                // Para segurança: NÃO confiar em queue_ids vindos do cliente.
                // Em vez disso, buscar as filas permitidas para o usuário no servidor
                db.all('SELECT queue_id FROM user_queues WHERE user_id = ?', [effectiveUserId], (qErr, qRows) => {
                    if (qErr) return res.status(500).json({ error: qErr.message });
                    const allowedQueueIds = qRows ? qRows.map(r => r.queue_id) : [];

                    if (!allowedQueueIds || allowedQueueIds.length === 0) {
                        // Sem filas atribuídas: apenas tickets atribuídos diretamente ao usuário
                        sql += ' AND user_id = ?';
                        params.push(effectiveUserId);
                    } else {
                        const queuePlaceholders = allowedQueueIds.map(() => '?').join(',');
                        // Mostrar tickets atribuídos ao usuário OU tickets pendentes SEM atribuição (user_id IS NULL)
                        // cuja queue_id pertence às filas que o usuário tem permissão.
                        sql += ` AND (user_id = ? OR (status = 'pending' AND user_id IS NULL AND (is_on_hold = 0 OR is_on_hold IS NULL) AND queue_id IN (${queuePlaceholders})))`;
                        params.push(effectiveUserId, ...allowedQueueIds);
                    }

                    sql += " ORDER BY last_message_at DESC";
                    db.all(sql, params, (err, rows) => {
                        if (err) return res.status(500).json({ error: err.message });
                        const formattedRows = rows.map(ticket => ({ ...ticket, formatted_last_message_time: formatLastMessageTime(ticket.last_message_at) }));
                        res.json(formattedRows);
                    });
                });
            });
        } else {
            // no user resolved - public or no-filter response
            sql += " ORDER BY last_message_at DESC";
            db.all(sql, params, (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                const formattedRows = rows.map(ticket => ({ ...ticket, formatted_last_message_time: formatLastMessageTime(ticket.last_message_at) }));
                res.json(formattedRows);
            });
        }
    }

    if (sessionToken) {
        db.get('SELECT user_id FROM user_sessions WHERE session_token = ?', [sessionToken], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            const resolved = row ? row.user_id : null;
            runQueryWithResolvedUser(resolved);
        });
    } else {
        runQueryWithResolvedUser(null);
    }
});

// GET ticket by protocol number
app.get('/api/tickets/protocol/:protocolNumber', (req, res) => {
    const { protocolNumber } = req.params;
    const sessionToken = req.query.sessionToken || req.headers['x-session-token'];
    const userIdParam = req.query.userId;

    function respondWithTicketForUser(effectiveUserId) {
        // If protocolNumber contains a dash, use exact match (legacy behavior).
        if (String(protocolNumber).includes('-')) {
            const query = 'SELECT * FROM tickets WHERE protocol_number = ?';
            const params = [protocolNumber];
            db.get(query, params, (err, ticket) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!ticket) return res.status(404).json({ error: 'Protocolo não encontrado.' });

                if (!effectiveUserId) {
                    // No user context - return limited info
                    return res.json({ id: ticket.id, protocol_number: ticket.protocol_number, contact_name: ticket.contact_name, contact_number: ticket.contact_number, status: ticket.status, has_access: false });
                }

                // Check if user is admin
                db.get('SELECT profile FROM users WHERE id = ?', [effectiveUserId], (profileErr, userProfile) => {
                    if (profileErr) return res.status(500).json({ error: profileErr.message });
                    const isAdmin = userProfile && (String(userProfile.profile).toLowerCase() === 'admin' || String(userProfile.profile).toLowerCase() === 'administrador');

                    // Admin sees everything
                    if (isAdmin) {
                        return res.json({ ...ticket, has_access: true });
                    }

                    // Check if ticket is assigned to this user
                    if (ticket.user_id && ticket.user_id == effectiveUserId) {
                        return res.json({ ...ticket, has_access: true });
                    }

                    // Check if ticket.queue_id is in user's queues para tickets sem atribuição
                    db.all('SELECT queue_id FROM user_queues WHERE user_id = ?', [effectiveUserId], (qErr, rows) => {
                        if (qErr) return res.status(500).json({ error: qErr.message });
                        const userQueueIds = rows ? rows.map(r => r.queue_id) : [];

                        // Regra de acesso: agente só tem acesso ao chat se for o responsável (user_id igual)
                        // ou se o ticket não tiver responsável e estiver em uma das filas do agente.
                        let hasAccess = false;
                        if (ticket.user_id && ticket.user_id == effectiveUserId) {
                            hasAccess = true;
                        } else if (!ticket.user_id && ticket.queue_id && userQueueIds.includes(ticket.queue_id)) {
                            hasAccess = true;
                        }

                        if (hasAccess) {
                            return res.json({ ...ticket, has_access: true });
                        }

                        // Sem acesso: retornar informações limitadas, sem chat
                        db.get('SELECT name FROM users WHERE id = ?', [ticket.user_id], (uErr, user) => {
                            const responsibleAgent = user ? user.name : 'Desconhecido';
                            return res.json({ id: ticket.id, protocol_number: ticket.protocol_number, contact_name: ticket.contact_name, contact_number: ticket.contact_number, status: ticket.status, responsible_agent: responsibleAgent, has_access: false });
                        });
                    });
                });
            });
            return;
        }

        // If user provided only the prefix (digits before hyphen), allow partial search using LIKE.
        // Example: searching for '528' should match '#528-111125'.
        const likePattern = `%${protocolNumber}-%`;
        db.all('SELECT * FROM tickets WHERE protocol_number LIKE ? ORDER BY last_message_at DESC LIMIT 50', [likePattern], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!rows || rows.length === 0) return res.status(404).json({ error: 'Protocolo não encontrado.' });

            // If no user context, return limited info list
            if (!effectiveUserId) {
                const result = rows.map(t => ({ id: t.id, protocol_number: t.protocol_number, contact_name: t.contact_name, contact_number: t.contact_number, status: t.status, has_access: false }));
                return res.json(result);
            }

            // Check if user is admin
            db.get('SELECT profile FROM users WHERE id = ?', [effectiveUserId], (profileErr, userProfile) => {
                if (profileErr) return res.status(500).json({ error: profileErr.message });
                const isAdmin = userProfile && (String(userProfile.profile).toLowerCase() === 'admin' || String(userProfile.profile).toLowerCase() === 'administrador');

                // Admin sees everything
                if (isAdmin) {
                    return res.json(rows.map(t => ({ ...t, has_access: true })));
                }

                // Resolve user's queues once to evaluate access per ticket
                db.all('SELECT queue_id FROM user_queues WHERE user_id = ?', [effectiveUserId], (qErr, qRows) => {
                    if (qErr) return res.status(500).json({ error: qErr.message });
                    const userQueueIds = qRows ? qRows.map(r => r.queue_id) : [];

                    const processed = [];
                    let pending = rows.length;
                    rows.forEach(t => {
                        // Regra de acesso ao chat: somente se for o responsável OU se o ticket estiver sem responsável e na fila do agente
                        const hasAccess = (t.user_id && t.user_id == effectiveUserId) || (!t.user_id && t.queue_id && userQueueIds.includes(t.queue_id));
                        if (hasAccess) {
                            processed.push({ ...t, has_access: true });
                            if (--pending === 0) return res.json(processed);
                        } else {
                            // Sem acesso: retornar informações limitadas
                            db.get('SELECT name FROM users WHERE id = ?', [t.user_id], (uErr, user) => {
                                const responsibleAgent = user ? user.name : 'Desconhecido';
                                processed.push({ id: t.id, protocol_number: t.protocol_number, contact_name: t.contact_name, contact_number: t.contact_number, status: t.status, responsible_agent: responsibleAgent, has_access: false });
                                if (--pending === 0) return res.json(processed);
                            });
                        }
                    });
                });
            });
        });
    }

    if (sessionToken) {
        db.get('SELECT user_id FROM user_sessions WHERE session_token = ?', [sessionToken], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            const resolved = row ? row.user_id : null;
            respondWithTicketForUser(resolved || userIdParam);
        });
    } else {
        respondWithTicketForUser(userIdParam);
    }
});

// GET messages for a specific ticket
app.get('/api/tickets/:id/messages', (req, res) => {
    const { id } = req.params;
    const sessionToken = req.query.sessionToken || req.headers['x-session-token'];
    const userIdParam = req.query.userId;

    function respondIfAllowed(effectiveUserId) {
        db.get('SELECT user_id, queue_id, connection_id, status, is_on_hold FROM tickets WHERE id = ?', [id], (err, ticket) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado.' });

            // Helper to continue permission checks and fetch messages
            function continueWithTicket(localTicket) {
                // Verifica se o usuário é Admin - Admin tem acesso a tudo
                if (effectiveUserId) {
                    db.get('SELECT profile FROM users WHERE id = ?', [effectiveUserId], (profErr, userProfile) => {
                        if (profErr) return res.status(500).json({ error: profErr.message });
                        const isAdmin = userProfile && (String(userProfile.profile).toLowerCase() === 'admin' || String(userProfile.profile).toLowerCase() === 'administrador');
                        
                        if (isAdmin) {
                            // Admin tem acesso total
                            return fetchMessages();
                        }
                        
                        // Para não-admin: se o ticket estiver atribuído a outro agente, negar acesso ao chat
                        if (localTicket.user_id && localTicket.user_id != effectiveUserId) {
                            return res.status(403).json({ error: 'Você não tem permissão para acessar este histórico.' });
                        } else {
                            // allowed (inclui tickets sem atribuição)
                            fetchMessages();
                        }
                    });
                } else if (!effectiveUserId && localTicket.user_id) {
                    // No user context and ticket assigned -> deny access to messages
                    return res.status(403).json({ error: 'Você não tem permissão para acessar este histórico.' });
                } else {
                    // allowed
                    fetchMessages();
                }
            }

            // Takeover automático DESABILITADO: tickets sem atribuição permanecem em pending até aceite manual
            // Apenas continua com checagem de permissões
            continueWithTicket(ticket);

            function fetchMessages() {
                db.all(`
                    SELECT 
                        m.*,
                        q.name as department_name
                    FROM messages m
                    LEFT JOIN tickets t ON t.id = m.ticket_id
                    LEFT JOIN queues q ON q.id = t.queue_id
                    WHERE m.ticket_id = ?
                    ORDER BY m.timestamp ASC
                `, [id], (mErr, messages) => {
                    if (mErr) return res.status(500).json({ error: mErr.message });
                    res.json(messages || []);
                });
            }
        });
    }

    if (sessionToken) {
        db.get('SELECT user_id FROM user_sessions WHERE session_token = ?', [sessionToken], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            const resolved = row ? row.user_id : null;
            respondIfAllowed(resolved || userIdParam);
        });
    } else {
        respondIfAllowed(userIdParam);
    }
});

// POST a new message to a ticket
app.post('/api/tickets/:id/messages', async (req, res) => {
    const { id } = req.params;
    const { message, userId } = req.body; // Adiciona userId

    logger.info(`[POST /api/tickets/${id}/messages] Recebida mensagem: "${message}" de userId: ${userId}`);

    const requestStartMs = Date.now();
    logger.info(`[POST /api/tickets/${id}/messages] Request start timestamp: ${requestStartMs}`);

    if (!message) {
        return res.status(400).json({ error: "A mensagem não pode estar vazia." });
    }

    // 1. Buscar informações do ticket (número do contato e ID da conexão)
    db.get("SELECT contact_number, connection_id FROM tickets WHERE id = ?", [id], async (err, ticket) => {
        if (err) {
            logger.error(`[POST /api/tickets/${id}/messages] Erro ao buscar ticket: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }
        if (!ticket) {
            logger.error(`[POST /api/tickets/${id}/messages] Ticket não encontrado`);
            return res.status(404).json({ error: "Ticket não encontrado." });
        }

        logger.info(`[POST /api/tickets/${id}/messages] Ticket encontrado - connection_id: ${ticket.connection_id}, contact: ${ticket.contact_number}`);

        // 2. Encontrar a sessão do WhatsApp ativa
        let client = null;
        let usedConnectionId = ticket.connection_id;

        if (ticket.connection_id) {
            // Ticket tem connection_id definida, usar essa conexão
            client = sessions[String(ticket.connection_id)];
        } else {
            // Ticket criado manualmente (sem connection_id), usar primeira conexão ativa disponível
            const activeConnections = Object.keys(sessions).filter(sessionId => {
                const session = sessions[sessionId];
                return session && session.info && session.info.wid;
            });
            
            if (activeConnections.length > 0) {
                usedConnectionId = activeConnections[0];
                client = sessions[usedConnectionId];
                logger.info(`[POST /api/tickets/${id}/messages] Usando conexão ativa ${usedConnectionId} para ticket manual`);
            }
        }

        let whatsappErrorMsg = null;
        // waMessageId deve existir independentemente de client para evitar ReferenceError
        let waMessageId = null;
        // sendStartMs declarado aqui para ser visível em todo o escopo da rota
        let sendStartMs = null;
        // Se não houver cliente, registra e deixa o worker cuidar do reenvio
        if (!client) {
            logger.warn(`[POST /api/tickets/${id}/messages] Nenhuma conexão WhatsApp ativa encontrada. Mensagem será registrada localmente.`);
            whatsappErrorMsg = 'Nenhuma sessão do WhatsApp ativa';
        } else {
            // marca tempo de início do envio para diagnóstico
            sendStartMs = Date.now();
            logger.info(`[POST /api/tickets/${id}/messages] Iniciando envio via WhatsApp (conexão ${usedConnectionId}) at ${sendStartMs}`);
            logger.info(`[POST /api/tickets/${id}/messages] Cliente WhatsApp encontrado (conexão ${usedConnectionId}), tentando enviar mensagem via WhatsApp...`);
        }

        // 3. Se houver cliente, tenta enviar; caso falhe, registra a falha mas continua salvando a mensagem localmente
        if (client) {
                try {
                const contactNumber = `${ticket.contact_number}@c.us`;

                // Busca o nome do usuário e a fila se userId foi fornecido (para incluir na mensagem WhatsApp)
                let userDisplay = null;
                if (userId) {
                    const user = await new Promise((resolve, reject) => {
                        db.get('SELECT name FROM users WHERE id = ?', [userId], (err, row) => {
                            if (err) reject(err);
                            else resolve(row);
                        });
                    });

                    if (user) {
                        userDisplay = user.name;

                        // Busca o nome da primeira fila do usuário na tabela user_queues
                        const queue = await new Promise((resolve) => {
                            db.get(`
                                SELECT q.name
                                FROM queues q
                                INNER JOIN user_queues uq ON q.id = uq.queue_id
                                WHERE uq.user_id = ?
                                LIMIT 1
                            `, [userId], (err, row) => {
                                if (err) {
                                    logger.warn('Erro ao buscar fila do usuário:', err.message || err);
                                }
                                resolve(row || null);
                            });
                        });

                        if (queue) {
                            userDisplay = `${user.name} | ${queue.name}`;
                        }
                    }
                }

                // Inclui o identificador do remetente na mensagem enviada via WhatsApp
                const whatsappMessage = userDisplay ? `*${userDisplay}*\n\n${message}` : message;

                // Mitigação: checar estado mínimo da sessão antes de tentar enviar
                const isSessionHealthy = client && client.info && client.info.wid;
                if (!isSessionHealthy || typeof client.sendMessage !== 'function') {
                    whatsappErrorMsg = 'Sessão WhatsApp não pronta';
                    logger.warn(`[POST /api/tickets/${id}/messages] Sessão ${usedConnectionId} não pronta para envio (isSessionHealthy=${!!isSessionHealthy}). Iremos limpar a sessão e deixar o worker/reattempt cuidar do reenvio.`);
                    try { await client.destroy(); } catch (destroyErr) { logger.warn(`Erro ao destruir sessão não saudável: ${destroyErr && destroyErr.message ? destroyErr.message : destroyErr}`); }
                    delete sessions[String(usedConnectionId)];
                } else {
                    // Tentativa com pequeno retry local para reduzir falhas intermitentes
                    let lastSendErr = null;
                    const LOCAL_SEND_ATTEMPTS = 2;
                    for (let attempt = 1; attempt <= LOCAL_SEND_ATTEMPTS; attempt++) {
                        try {
                            if (attempt > 1) await new Promise(r => setTimeout(r, 400));
                            const waMsg = await safeSendMessage(client, contactNumber, whatsappMessage);
                            logger.info(`[POST /api/tickets/${id}/messages] Mensagem enviada com sucesso via WhatsApp (conexão ${usedConnectionId})`);
                            try { waMessageId = waMsg && waMsg.id && waMsg.id._serialized ? waMsg.id._serialized : null; } catch(e) { waMessageId = null; }
                            const sendEndMs = Date.now();
                            logger.info(`[POST /api/tickets/${id}/messages] Envio via WhatsApp finalizado (conexão ${usedConnectionId}) at ${sendEndMs} duration=${sendEndMs - sendStartMs}ms waMessageId=${waMessageId}`);

                            // Se o ticket não tinha connection_id, atualizar com a conexão usada
                            if (!ticket.connection_id && usedConnectionId) {
                                db.run('UPDATE tickets SET connection_id = ? WHERE id = ?', [usedConnectionId, id], (updateErr) => {
                                    if (updateErr) {
                                        logger.warn(`[POST /api/tickets/${id}/messages] Erro ao atualizar connection_id do ticket: ${updateErr.message}`);
                                    } else {
                                        logger.info(`[POST /api/tickets/${id}/messages] Ticket atualizado com connection_id: ${usedConnectionId}`);
                                    }
                                });
                            }

                            whatsappErrorMsg = null;
                            lastSendErr = null;
                            // Reseta contador de erros críticos em caso de sucesso
                            if (sessionCriticalErrors[usedConnectionId]) {
                                sessionCriticalErrors[usedConnectionId] = 0;
                            }
                            break; // sucesso -> sai do loop
                        } catch (error) {
                            lastSendErr = error;
                            const eMsg = error && error.message ? error.message : String(error);
                            const eStack = error && error.stack ? error.stack : null;
                            logger.warn(`[POST /api/tickets/${id}/messages] Tentativa ${attempt} falhou ao enviar via WhatsApp: ${eMsg}`);

                            // Se for erro crítico no WAPI/puppeteer, incrementa contador
                            const low = (eStack || eMsg || '').toLowerCase();
                            if (low.includes('evaluation failed') || low.includes('session closed') || low.includes('target closed') || low.includes('protocol error')) {
                                sessionCriticalErrors[usedConnectionId] = (sessionCriticalErrors[usedConnectionId] || 0) + 1;
                                logger.warn(`[POST /api/tickets/${id}/messages] Erro crítico na sessão ${usedConnectionId} (${sessionCriticalErrors[usedConnectionId]}/${MAX_CRITICAL_ERRORS})`);
                                
                                // Só destrói sessão após múltiplos erros E verifica se realmente está desconectada
                                if (sessionCriticalErrors[usedConnectionId] >= MAX_CRITICAL_ERRORS) {
                                    try {
                                        let shouldDestroy = true;
                                        try {
                                            const state = await client.getState();
                                            if (state === 'CONNECTED') {
                                                logger.info(`[POST /api/tickets/${id}/messages] Sessão ${usedConnectionId} ainda está CONNECTED, resetando contador em vez de destruir.`);
                                                sessionCriticalErrors[usedConnectionId] = 0;
                                                shouldDestroy = false;
                                            }
                                        } catch (stateErr) { /* se falhar ao verificar estado, assume que deve destruir */ }
                                        
                                        if (shouldDestroy) {
                                            logger.info(`[POST /api/tickets/${id}/messages] Destruindo sessão ${usedConnectionId} após ${sessionCriticalErrors[usedConnectionId]} erros críticos.`);
                                            try { await client.destroy(); } catch (destroyErr) { logger.warn(`Erro ao destruir client: ${destroyErr && destroyErr.message ? destroyErr.message : destroyErr}`); }
                                            delete sessions[String(usedConnectionId)];
                                            delete sessionCriticalErrors[usedConnectionId];
                                            logger.info(`[POST /api/tickets/${id}/messages] Sessão ${usedConnectionId} removida.`);
                                            whatsappErrorMsg = eMsg;
                                            break;
                                        }
                                    } catch (cleanupErr) {
                                        logger.warn('Falha ao processar erro crítico:', cleanupErr && cleanupErr.message ? cleanupErr.message : cleanupErr);
                                    }
                                }
                                // Aguarda 2s antes da próxima tentativa
                                if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
                            }
                        }
                    }

                    if (lastSendErr) {
                        const eMsg = lastSendErr && lastSendErr.message ? lastSendErr.message : String(lastSendErr);
                        whatsappErrorMsg = eMsg;
                        const errStack = lastSendErr && lastSendErr.stack ? lastSendErr.stack : null;
                        logger.error(`[POST /api/tickets/${id}/messages] Erro ao enviar mensagem via WhatsApp (após tentativas): ${whatsappErrorMsg}${errStack ? '\n' + errStack : ''}`);
                    }
                }
            } catch (error) {
                whatsappErrorMsg = error && error.message ? error.message : String(error);
                const errStack = error && error.stack ? error.stack : null;
                logger.error(`[POST /api/tickets/${id}/messages] Erro inesperado ao tentar enviar via WhatsApp: ${whatsappErrorMsg}${errStack ? '\n' + errStack : ''}`);
            }
        }

        // 4. Salvar a mensagem no banco de dados SEMPRE (comportamento resiliente)
        const messageTime = getLocalDateTime();

        // Busca o nome do usuário e a fila se userId foi fornecido
        let userDisplay = null;
        if (userId) {
            const user = await new Promise((resolve, reject) => {
                db.get('SELECT name FROM users WHERE id = ?', [userId], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });

            if (user) {
                userDisplay = user.name;

                // Busca o nome da primeira fila do usuário na tabela user_queues
                const queue = await new Promise((resolve) => {
                    db.get(`
                        SELECT q.name
                        FROM queues q
                        INNER JOIN user_queues uq ON q.id = uq.queue_id
                        WHERE uq.user_id = ?
                        LIMIT 1
                    `, [userId], (err, row) => {
                        if (err) {
                            logger.warn('Erro ao buscar fila do usuário:', err.message || err);
                        }
                        resolve(row || null);
                    });
                });

                if (queue) {
                    userDisplay = `${user.name} | ${queue.name}`;
                }
            }
        }

        db.run('INSERT INTO messages (ticket_id, body, sender, user_id, user_name, timestamp, sent_via_whatsapp, wa_message_id, delivered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 
            [id, message, 'user', userId || null, userDisplay, messageTime, whatsappErrorMsg ? 0 : 1, waMessageId, 0], 
            function(err) {
                if (err) {
                    logger.error(`Erro ao salvar mensagem no banco: ${err.message}`);
                    return res.status(500).json({ error: 'Erro ao salvar mensagem.' });
                }

                logger.info(`[POST /api/tickets/${id}/messages] Mensagem salva no banco - message_id: ${this.lastID}, user: ${userDisplay}`);
                const afterSaveMs = Date.now();
                logger.info(`[POST /api/tickets/${id}/messages] DB insert completed at ${afterSaveMs} elapsed_since_request=${afterSaveMs - requestStartMs}ms`);

                const savedMessageId = this.lastID;

                // Busca queue_id do ticket para incluir no evento new-message
                db.get('SELECT queue_id, user_id FROM tickets WHERE id = ?', [id], (tErr, ticketInfo) => {
                    const ticketQueueId = ticketInfo && ticketInfo.queue_id ? ticketInfo.queue_id : null;
                    const ticketUserId = ticketInfo && ticketInfo.user_id ? ticketInfo.user_id : null;

                    // Emite evento de nova mensagem para atualizar UI em tempo real
                    io.emit('new-message', {
                        id: savedMessageId,
                        ticket_id: id,
                        body: message,
                        sender: 'bot',
                        user_id: userId || null,
                        user_name: userDisplay,
                        timestamp: messageTime,
                        sent_via_whatsapp: whatsappErrorMsg ? 0 : 1,
                        wa_message_id: waMessageId || null,
                        delivered: 0,
                        queue_id: ticketQueueId,
                        ticket_user_id: ticketUserId
                    });
                    
                    // Quando um agente envia mensagem, limpa timers automáticos pendentes para este contato
                    clearPendingTimers(ticket.contact_number);
                    
                    logger.info(`[POST /api/tickets/${id}/messages] Evento 'new-message' emitido via WebSocket`);

                    db.run('UPDATE tickets SET last_message = ?, last_message_at = ? WHERE id = ?', [`Você: ${message}`, messageTime, id]);

                    // Incluir user_id no evento para que clientes possam aplicar filtragem correta
                    io.emit('ticket_update', { id: parseInt(id, 10), status: 'attending', user_id: userId || null });

                    // Responde com sucesso indicando se foi enviado via WhatsApp
                    if (whatsappErrorMsg) {
                        return res.status(201).json({ message: 'Mensagem registrada no chat, mas não foi enviada via WhatsApp.', sent: false, detail: whatsappErrorMsg });
                    }

                    return res.status(201).json({ message: 'Mensagem enviada e registrada no chat.', sent: true });
                });
            }
        );
    });
});

// UPDATE a ticket status
app.put('/api/tickets/:id/status', (req, res) => {
    const { id } = req.params;
    const { status, on_hold, user_id, queue_id } = req.body;

    if (!status) {
        return res.status(400).json({ error: "O status é obrigatório." });
    }

    let sql = 'UPDATE tickets SET status = ?, unread_messages = 0';
    const params = [status];
    
    // Se informar on_hold, usar; se status for attending, zera on_hold
    if (typeof on_hold !== 'undefined') {
        sql += ', is_on_hold = ?';
        params.push(on_hold ? 1 : 0);
    } else if (status === 'attending') {
        sql += ', is_on_hold = 0';
    }
    
    // Se informar user_id, atualiza o agente
    if (user_id) {
        sql += ', user_id = ?';
        params.push(user_id);
    }
    
    // Se informar queue_id, atualiza o departamento
    if (queue_id) {
        sql += ', queue_id = ?';
        params.push(queue_id);
    }
    
    sql += ' WHERE id = ?';
    params.push(id);

    db.run(sql, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logger.info(`Ticket ${id} atualizado -> status=${status} user_id=${user_id || 'N/A'} queue_id=${queue_id || 'N/A'} on_hold=${typeof on_hold !== 'undefined' ? on_hold : '(mantido ou reset se attending)'}`);
        io.emit('ticket_update', { id: id, status: status });
        res.json({ message: "Status do ticket atualizado com sucesso." });
        // Se status for 'resolved', enviar mensagem de despedida pelo Bot (rota alternativa)
        if (status === 'resolved') {
            (async () => {
                try {
                    const ticketRow = await new Promise((resolve, reject) => {
                        db.get('SELECT contact_number, connection_id FROM tickets WHERE id = ?', [id], (err, row) => {
                            if (err) return reject(err);
                            resolve(row || null);
                        });
                    });
                    if (!ticketRow) return logger.warn(`Ao enviar despedida (rota simples): ticket ${id} não encontrado.`);

                    let client = null;
                    let usedConnectionId = ticketRow.connection_id;
                    if (ticketRow.connection_id) client = sessions[String(ticketRow.connection_id)];
                    if (!client) {
                        const activeConnections = Object.keys(sessions).filter(sessionId => {
                            const session = sessions[sessionId];
                            return session && session.info && session.info.wid;
                        });
                        if (activeConnections.length > 0) {
                            usedConnectionId = activeConnections[0];
                            client = sessions[usedConnectionId];
                        }
                    }

                    let farewell = null;
                    if (usedConnectionId) {
                        try {
                            const connRow = await new Promise((resolve) => {
                                db.get('SELECT farewell_message FROM connections WHERE id = ?', [usedConnectionId], (cErr, cRow) => resolve(cRow || null));
                            });
                            if (connRow && connRow.farewell_message) farewell = String(connRow.farewell_message).trim();
                        } catch (e) {
                            logger.warn('Erro ao ler farewell_message (rota simples): ' + (e && e.message));
                        }
                    }

                    if (!farewell) {
                        try {
                            const cfgRow = await new Promise((resolve) => {
                                db.get('SELECT thank_you_message FROM chatbot_config ORDER BY id DESC LIMIT 1', (cfgErr, cfg) => resolve(cfg || null));
                            });
                            if (cfgRow && cfgRow.thank_you_message) farewell = cfgRow.thank_you_message;
                        } catch (e) {
                            logger.warn('Erro ao ler thank_you_message (rota simples): ' + (e && e.message));
                        }
                    }

                    if (!farewell) farewell = 'Obrigado! Caso precise de mais suporte, envie uma nova mensagem para reabrir o atendimento.';

                    const contactId = `${ticketRow.contact_number}@c.us`;

                    if (!client) {
                        const sentAt = getLocalDateTime();
                        db.run('INSERT INTO messages (ticket_id, body, sender, timestamp) VALUES (?, ?, ?, ?)', [id, farewell, 'bot', sentAt], function(saveErr) {
                            if (saveErr) logger.warn(`Falha ao salvar mensagem de despedida (rota simples) para ticket ${id}: ${saveErr.message}`);
                            else io.emit('new-message', { id: this.lastID, ticket_id: id, body: farewell, sender: 'bot', timestamp: sentAt });
                        });
                        return;
                    }

                    try {
                        const waMsg = await safeSendMessage(client, contactId, farewell);
                        const waId = waMsg && waMsg.id && waMsg.id._serialized ? waMsg.id._serialized : null;
                        const sentAt = getLocalDateTime();
                        db.run('INSERT INTO messages (ticket_id, body, sender, timestamp, sent_via_whatsapp, wa_message_id, delivered) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, farewell, 'bot', sentAt, 1, waId, 0], function(saveErr) {
                            if (saveErr) logger.warn(`Falha ao salvar mensagem de despedida (rota simples) para ticket ${id}: ${saveErr.message}`);
                            else io.emit('new-message', { id: this.lastID, ticket_id: id, body: farewell, sender: 'bot', timestamp: sentAt, sent_via_whatsapp: 1, wa_message_id: waId, delivered: 0 });
                        });
                    } catch (sendErr) {
                        logger.error(`Erro ao enviar mensagem de despedida via WhatsApp (rota simples) para ticket ${id}: ${sendErr && sendErr.message}`);
                        const sentAt = getLocalDateTime();
                        db.run('INSERT INTO messages (ticket_id, body, sender, timestamp) VALUES (?, ?, ?, ?)', [id, farewell, 'bot', sentAt], function(saveErr) {
                            if (saveErr) logger.warn(`Falha ao salvar mensagem de despedida após erro de envio (rota simples) para ticket ${id}: ${saveErr.message}`);
                            else io.emit('new-message', { id: this.lastID, ticket_id: id, body: farewell, sender: 'bot', timestamp: sentAt });
                        });
                    }
                } catch (e) {
                    logger.error('Erro inesperado ao processar despedida (rota simples): ' + (e && e.message));
                }
            })();
        }
    });
});

// Endpoint para reenvio manual de uma mensagem específica
app.post('/api/messages/:id/resend', async (req, res) => {
    const { id } = req.params;
    logger.info(`[POST /api/messages/${id}/resend] Requisição de reenvio manual iniciada.`);

    db.get('SELECT * FROM messages WHERE id = ?', [id], async (err, message) => {
        if (err) {
            logger.error(`Erro ao buscar mensagem ${id}: ${err.message}`);
            return res.status(500).json({ ok: false, error: err.message });
        }
        if (!message) {
            return res.status(404).json({ ok: false, error: 'Mensagem não encontrada.' });
        }

        // busca ticket e número
        db.get('SELECT contact_number, connection_id FROM tickets WHERE id = ?', [message.ticket_id], async (tErr, ticket) => {
            if (tErr || !ticket) {
                logger.warn(`Não foi possível buscar ticket ${message.ticket_id} para reenvio da mensagem ${id}`);
                return res.status(404).json({ ok: false, error: 'Ticket não encontrado para mensagem.' });
            }

            // escolhe sessão ativa (prioriza connection_id do ticket)
            let client = null;
            let usedConnectionId = ticket.connection_id;
            if (ticket.connection_id && sessions[String(ticket.connection_id)]) {
                client = sessions[String(ticket.connection_id)];
            } else {
                const activeConnections = Object.keys(sessions).filter(sessionId => {
                    const s = sessions[sessionId];
                    return s && s.info && s.info.wid;
                });
                if (activeConnections.length > 0) {
                    usedConnectionId = activeConnections[0];
                    client = sessions[usedConnectionId];
                }
            }

            if (!client) {
                logger.info(`Nenhuma sessão ativa encontrada para reenvio manual da mensagem ${id}.`);
                return res.status(409).json({ ok: false, error: 'Nenhuma sessão WhatsApp ativa no momento.' });
            }

            const contactId = `${ticket.contact_number}@c.us`;

            // Verifica saúde básica da sessão
            const isSessionHealthy = client && client.info && client.info.wid;
            if (!isSessionHealthy || typeof client.sendMessage !== 'function') {
                try { await client.destroy(); } catch (destroyErr) { logger.warn('Erro ao destruir sessão não saudável durante reenvio manual:', destroyErr && destroyErr.message ? destroyErr.message : destroyErr); }
                delete sessions[String(usedConnectionId)];
                return res.status(409).json({ ok: false, error: 'Sessão encontrada não está pronta. Limpei a sessão; aguarde reconexão.' });
            }

            try {
                let waMsg;
                
                // Verifica se é uma mensagem de arquivo
                const fileMatch = message.body.match(/^\[Arquivo: (.+)\]$/);
                if (fileMatch) {
                    // É um arquivo - enviar como MessageMedia
                    const fileName = fileMatch[1];
                    const filePath = path.join(__dirname, 'uploads', fileName);
                    const fs = require('fs');
                    
                    if (!fs.existsSync(filePath)) {
                        throw new Error(`Arquivo não encontrado: ${fileName}`);
                    }
                    
                    logger.info(`Reenviando arquivo: ${filePath}`);
                    const media = MessageMedia.fromFilePath(filePath);
                    
                    // Se for áudio, usa configurações especiais
                    if (fileName.endsWith('.ogg') || fileName.endsWith('.webm')) {
                        media.mimetype = 'audio/ogg; codecs=opus';
                        waMsg = await safeSendMessage(client, contactId, media, { sendAudioAsVoice: true });
                    } else {
                        waMsg = await safeSendMessage(client, contactId, media);
                    }
                } else {
                    // É uma mensagem de texto normal
                    waMsg = await safeSendMessage(client, contactId, message.body);
                }
                
                const waId = waMsg && waMsg.id && waMsg.id._serialized ? waMsg.id._serialized : null;
                // marca como enviada e registra wa_message_id
                db.run('UPDATE messages SET sent_via_whatsapp = 1, wa_message_id = ? WHERE id = ?', [waId, id], (uErr) => {
                    if (uErr) {
                        logger.warn(`Falha ao marcar mensagem ${id} como enviada: ${uErr.message}`);
                    }
                });

                logger.info(`Mensagem ${id} reenviada com sucesso via conexão ${usedConnectionId}.`);
                // Reseta contador de erros críticos em caso de sucesso
                if (sessionCriticalErrors[usedConnectionId]) {
                    sessionCriticalErrors[usedConnectionId] = 0;
                }
                io.emit('message_update', { id: parseInt(id, 10), sent_via_whatsapp: 1, wa_message_id: waId });
                return res.json({ ok: true, message: 'Mensagem reenviada com sucesso.' });
            } catch (sendErr) {
                const eMsg = sendErr && sendErr.message ? sendErr.message : String(sendErr);
                const eStack = sendErr && sendErr.stack ? sendErr.stack : null;
                logger.warn(`Falha ao reenviar mensagem ${id} manualmente: ${eMsg}${eStack ? '\n' + eStack : ''}`);
                // se erro crítico, incrementa contador
                const low = (eStack || eMsg || '').toLowerCase();
                if (low.includes('evaluation failed') || low.includes('session closed') || low.includes('target closed') || low.includes('protocol error')) {
                    sessionCriticalErrors[usedConnectionId] = (sessionCriticalErrors[usedConnectionId] || 0) + 1;
                    logger.warn(`Erro crítico no reenvio manual (${sessionCriticalErrors[usedConnectionId]}/${MAX_CRITICAL_ERRORS})`);
                    
                    if (sessionCriticalErrors[usedConnectionId] >= MAX_CRITICAL_ERRORS) {
                        try {
                            let shouldDestroy = true;
                            try {
                                const state = await client.getState();
                                if (state === 'CONNECTED') {
                                    logger.info(`Sessão ${usedConnectionId} ainda CONNECTED, resetando contador.`);
                                    sessionCriticalErrors[usedConnectionId] = 0;
                                    shouldDestroy = false;
                                }
                            } catch (stateErr) { /* assume destruir */ }
                            
                            if (shouldDestroy) {
                                logger.info(`Destruindo sessão ${usedConnectionId} após ${sessionCriticalErrors[usedConnectionId]} erros.`);
                                try { await client.destroy(); } catch (destroyErr) { logger.warn('Erro ao destruir sessão:', destroyErr && destroyErr.message ? destroyErr.message : destroyErr); }
                                delete sessions[String(usedConnectionId)];
                                delete sessionCriticalErrors[usedConnectionId];
                                logger.info(`Sessão ${usedConnectionId} removida após erro crítico no reenvio manual.`);
                            }
                        } catch (e) { logger.warn('Falha ao processar erro crítico:', e && e.message); }
                    }
                }
                return res.status(500).json({ ok: false, error: eMsg });
            }
        });
    });
});

// Rota de debug: sumariza tickets por status e on_hold
app.get('/api/debug/tickets-summary', (req, res) => {
    const sql = `SELECT status, is_on_hold, COUNT(*) as total FROM tickets GROUP BY status, is_on_hold ORDER BY status, is_on_hold`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ summary: rows });
    });
});

// --- Respostas Rápidas (Quick Responses) ---
// GET: listar respostas rápidas do usuário logado
app.get('/api/quick-responses', (req, res) => {
    const sessionToken = req.query.sessionToken || req.headers['x-session-token'];
    
    if (!sessionToken) {
        return res.status(401).json({ error: 'Sessão não informada.' });
    }
    
    // Resolve user_id from session token
    db.get('SELECT user_id FROM user_sessions WHERE session_token = ?', [sessionToken], (err, session) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!session) return res.status(401).json({ error: 'Sessão inválida.' });
        
        const userId = session.user_id;
        db.all('SELECT id, shortcut, response, created_at, updated_at FROM quick_responses WHERE user_id = ? ORDER BY shortcut ASC', [userId], (qErr, rows) => {
            if (qErr) return res.status(500).json({ error: qErr.message });
            res.json(rows || []);
        });
    });
});

// POST: criar nova resposta rápida
app.post('/api/quick-responses', (req, res) => {
    const { shortcut, response } = req.body || {};
    const sessionToken = req.body.sessionToken || req.headers['x-session-token'];
    
    if (!sessionToken) {
        return res.status(401).json({ error: 'Sessão não informada.' });
    }
    
    const sc = String(shortcut || '').trim();
    const rp = String(response || '').trim();
    if (!sc || !rp) return res.status(400).json({ error: 'Atalho e resposta são obrigatórios.' });
    
    // Resolve user_id from session token
    db.get('SELECT user_id FROM user_sessions WHERE session_token = ?', [sessionToken], (err, session) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!session) return res.status(401).json({ error: 'Sessão inválida.' });
        
        const userId = session.user_id;
        // Normaliza para começar com '\'
        const normalized = sc.startsWith('\\') ? sc : '\\' + sc;
        const now = getLocalDateTime();
        const sql = 'INSERT INTO quick_responses (shortcut, response, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)';
        db.run(sql, [normalized, rp, userId, now, now], function(insertErr) {
            if (insertErr) {
                if (String(insertErr.message || '').includes('UNIQUE')) {
                    return res.status(409).json({ error: 'Você já possui uma resposta rápida com este atalho.' });
                }
                return res.status(500).json({ error: insertErr.message });
            }
            db.get('SELECT id, shortcut, response, created_at, updated_at FROM quick_responses WHERE id = ?', [this.lastID], (gErr, row) => {
                if (gErr) return res.status(500).json({ error: gErr.message });
                res.status(201).json(row);
            });
        });
    });
});

// PUT: atualizar resposta rápida
app.put('/api/quick-responses/:id', (req, res) => {
    const { id } = req.params;
    const { shortcut, response } = req.body || {};
    const sessionToken = req.body.sessionToken || req.headers['x-session-token'];
    
    if (!sessionToken) {
        return res.status(401).json({ error: 'Sessão não informada.' });
    }
    
    const sc = typeof shortcut === 'string' ? shortcut.trim() : null;
    const rp = typeof response === 'string' ? response.trim() : null;
    if (!sc && !rp) return res.status(400).json({ error: 'Nada para atualizar.' });
    
    // Resolve user_id from session token
    db.get('SELECT user_id FROM user_sessions WHERE session_token = ?', [sessionToken], (err, session) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!session) return res.status(401).json({ error: 'Sessão inválida.' });
        
        const userId = session.user_id;
        const fields = [];
        const params = [];
        if (sc) {
            const normalized = sc.startsWith('\\') ? sc : '\\' + sc;
            fields.push('shortcut = ?');
            params.push(normalized);
        }
        if (rp) {
            fields.push('response = ?');
            params.push(rp);
        }
        fields.push('updated_at = ?');
        params.push(getLocalDateTime());
        params.push(id);
        params.push(userId);
        const sql = `UPDATE quick_responses SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`;
        db.run(sql, params, function(updateErr) {
            if (updateErr) {
                if (String(updateErr.message || '').includes('UNIQUE')) {
                    return res.status(409).json({ error: 'Você já possui uma resposta rápida com este atalho.' });
                }
                return res.status(500).json({ error: updateErr.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: 'Resposta rápida não encontrada ou você não tem permissão.' });
            db.get('SELECT id, shortcut, response, created_at, updated_at FROM quick_responses WHERE id = ?', [id], (gErr, row) => {
                if (gErr) return res.status(500).json({ error: gErr.message });
                res.json(row);
            });
        });
    });
});

// DELETE: excluir resposta rápida
app.delete('/api/quick-responses/:id', (req, res) => {
    const { id } = req.params;
    const sessionToken = req.query.sessionToken || req.headers['x-session-token'];
    
    if (!sessionToken) {
        return res.status(401).json({ error: 'Sessão não informada.' });
    }
    
    // Resolve user_id from session token
    db.get('SELECT user_id FROM user_sessions WHERE session_token = ?', [sessionToken], (err, session) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!session) return res.status(401).json({ error: 'Sessão inválida.' });
        
        const userId = session.user_id;
        db.run('DELETE FROM quick_responses WHERE id = ? AND user_id = ?', [id, userId], function(delErr) {
            if (delErr) return res.status(500).json({ error: delErr.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Resposta rápida não encontrada ou você não tem permissão.' });
            res.json({ message: 'Excluída com sucesso.' });
        });
    });
});

// Rota para enviar arquivo via WhatsApp
app.post('/api/send-file', upload.single('file'), async (req, res) => {
    try {
        const { ticketId, userId } = req.body; // Adiciona userId
        
        if (!ticketId) {
            return res.status(400).json({ error: 'ID do ticket é obrigatório.' });
        }
        
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo foi enviado.' });
        }
        
        // Se for áudio webm, converte para ogg antes de enviar
        let audioConvertedPath = null;
        let audioToSendPath = req.file.path;
        let audioToSendMimetype = req.file.mimetype;
        if (req.file.mimetype === 'audio/webm' && req.file.path.endsWith('.webm')) {
            const { execSync } = require('child_process');
            const path = require('path');
            const fs = require('fs');
            // Usa o ffmpeg do sistema (Linux) em vez do ffmpeg.exe (Windows)
            const ffmpegPath = '/usr/bin/ffmpeg';
            const oggPath = req.file.path.replace(/\.webm$/i, '.ogg');
            try {
                // Executa conversão sem aspas duplas extras
                execSync(`${ffmpegPath} -y -i "${req.file.path}" -c:a libopus -b:a 64k -vn "${oggPath}"`, {
                    stdio: 'pipe'
                });
                // Verifica se o arquivo foi criado com sucesso
                if (fs.existsSync(oggPath)) {
                    audioConvertedPath = oggPath;
                    audioToSendPath = oggPath;
                    audioToSendMimetype = 'audio/ogg';
                    logger.info(`Áudio convertido de webm para ogg: ${oggPath}`);
                } else {
                    logger.warn('Arquivo convertido não foi criado, usando original webm');
                }
            } catch (err) {
                logger.error('Falha ao converter áudio webm para ogg:', err.message);
                logger.warn('Usando arquivo webm original sem conversão');
            }
        }

        // Busca informações do ticket
        db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], async (err, ticket) => {
            if (err) {
                logger.error(`Erro ao buscar ticket: ${err.message}`);
                return res.status(500).json({ error: 'Erro ao buscar ticket.' });
            }
            
            if (!ticket) {
                return res.status(404).json({ error: 'Ticket não encontrado.' });
            }
            
            // Busca a sessão do WhatsApp (igual ao envio de texto)
            const client = sessions[String(ticket.connection_id)];
            if (!client) {
                logger.warn(`Sessão do WhatsApp não encontrada para conexão ${ticket.connection_id}`);
                // Continua e salva apenas no banco, sem enviar via WhatsApp
            }
            
            let whatsappErrorMsg = null;
            let waMessageId = null;
            
            // Tenta enviar via WhatsApp apenas se houver cliente conectado
            if (client) {
                try {
                    // Verifica se o cliente está realmente conectado
                    const state = await client.getState();
                    if (state !== 'CONNECTED') {
                        throw new Error('Cliente WhatsApp não está conectado. Estado atual: ' + state);
                    }
                    
                    // Verifica se o arquivo existe antes de tentar enviar
                    const fs = require('fs');
                    if (!fs.existsSync(audioToSendPath)) {
                        throw new Error(`Arquivo não encontrado: ${audioToSendPath}`);
                    }
                    
                    logger.info(`Preparando envio de arquivo: ${audioToSendPath} (${audioToSendMimetype})`);
                    
                    // Cria o MessageMedia a partir do arquivo correto (convertido se necessário)
                    const media = MessageMedia.fromFilePath(audioToSendPath);
                    
                    // Para áudio, força mimetype e opções especiais
                    let sendOptions = {};
                    if (audioToSendMimetype.startsWith('audio/')) {
                        media.mimetype = 'audio/ogg; codecs=opus';
                        sendOptions.sendAudioAsVoice = true;
                    }
                    
                    // Envia o arquivo via WhatsApp
                    const waMsg = await safeSendMessage(client, `${ticket.contact_number}@c.us`, media, sendOptions);
                    
                    // Captura o wa_message_id para poder rastrear acks
                    waMessageId = waMsg && waMsg.id && waMsg.id._serialized ? waMsg.id._serialized : null;
                    
                    logger.info(`Arquivo enviado via WhatsApp para ticket ${ticketId}: ${audioToSendPath} (wa_id: ${waMessageId})`);
                } catch (whatsappError) {
                    logger.error(`Erro ao enviar arquivo via WhatsApp: ${whatsappError.message}`);
                    whatsappErrorMsg = whatsappError.message;
                }
            } else {
                whatsappErrorMsg = 'Sessão do WhatsApp não encontrada';
            }
            
            // Registra a mensagem no banco de dados SEMPRE
            // Salva o nome do arquivo COM o prefixo de timestamp para permitir acesso correto
            const messageText = `[Arquivo: ${req.file.filename}]`;
            const timestamp = getLocalDateTime();
            const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
            
            // Busca o nome do usuário e a fila se userId foi fornecido
            const getUserNameAndQueue = async () => {
                if (!userId) return { userDisplay: null };
                
                return new Promise((resolve) => {
                    db.get('SELECT name FROM users WHERE id = ?', [userId], async (err, user) => {
                        if (err || !user) {
                            return resolve({ userDisplay: null });
                        }
                        
                        let userName = user.name;
                        let queueName = null;
                        
                        // Busca o nome da primeira fila do usuário na tabela user_queues
                        const queue = await new Promise((resolve) => {
                            db.get(`
                                SELECT q.name 
                                FROM queues q
                                INNER JOIN user_queues uq ON q.id = uq.queue_id
                                WHERE uq.user_id = ?
                                LIMIT 1
                            `, [userId], (err, row) => {
                                if (err) {
                                    console.error('Erro ao buscar fila:', err);
                                }
                                resolve(row || null);
                            });
                        });
                        queueName = queue ? queue.name : null;
                        
                        // Cria a string de exibição: "Nome do Usuário | Nome da Fila"
                        let userDisplay = userName;
                        if (userName && queueName) {
                            userDisplay = `${userName} | ${queueName}`;
                        }
                        
                        resolve({ userDisplay });
                    });
                });
            };
            
            getUserNameAndQueue().then(({ userDisplay }) => {
                // Define se foi enviado via WhatsApp com sucesso
                const sentViaWhatsapp = whatsappErrorMsg ? 0 : 1;
                
                db.run(
                    `INSERT INTO messages (ticket_id, body, sender, user_id, user_name, timestamp, file_expires_at, sent_via_whatsapp, wa_message_id, delivered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [ticketId, messageText, 'bot', userId || null, userDisplay, timestamp, expiresAt, sentViaWhatsapp, waMessageId, 0],
                    function(err) {
                        if (err) {
                            logger.error(`Erro ao salvar mensagem: ${err.message}`);
                            return res.status(500).json({ error: 'Erro ao salvar mensagem.' });
                        }
                        const messageId = this.lastID;
                        // Emite via Socket.IO para atualizar em tempo real
                        io.emit('new-message', {
                            id: messageId,
                            ticket_id: ticketId,
                            body: messageText,
                            sender: 'bot',
                            user_id: userId || null,
                            user_name: userDisplay,
                            timestamp: timestamp
                        });
                        logger.info(`Arquivo registrado no chat para ticket ${ticketId}: ${req.file.originalname}, user: ${userDisplay}`);
                        res.json({ 
                            success: !whatsappErrorMsg,
                            message: whatsappErrorMsg ? 'Arquivo registrado no chat, mas falhou no WhatsApp: ' + whatsappErrorMsg : 'Arquivo enviado com sucesso.',
                            messageId: messageId
                        });
                    }
                );
            });
        });
    } catch (error) {
        logger.error(`Erro geral ao processar upload: ${error.message}`);
        
        // Remove o arquivo em caso de erro
        if (req.file) {
            fs.unlink(req.file.path, (unlinkErr) => {
                if (unlinkErr) {
                    logger.warn(`Erro ao remover arquivo após falha: ${unlinkErr.message}`);
                }
            });
        }
        
        res.status(500).json({ error: 'Erro ao processar upload de arquivo.' });
    }
});

// Rota para transferir um ticket
app.post('/api/tickets/:id/transfer', (req, res) => {
    const { id } = req.params;
    const { queueId, userId, transferHistory, sessionToken } = req.body;

    if (!queueId) {
        return res.status(400).json({ error: "A fila de destino é obrigatória." });
    }

    if (!sessionToken) {
        return res.status(400).json({ error: 'sessionToken é obrigatório' });
    }

    // Validar sessão e obter userId do usuário autenticado
    db.get('SELECT user_id FROM user_sessions WHERE session_token = ? AND user_id IS NOT NULL', [sessionToken], (err, session) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!session) return res.status(401).json({ error: 'Sessão inválida' });

        const transferUserId = session.user_id;

        // Verifica se deve transferir o histórico ou criar um novo ticket
        if (transferHistory === 'no') {
            // Opção 2: Resolver ticket atual e criar novo ticket vazio
            db.get('SELECT * FROM tickets WHERE id = ?', [id], (err, ticket) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!ticket) return res.status(404).json({ error: "Ticket não encontrado." });

                // Resolve o ticket atual
                db.run('UPDATE tickets SET status = ?, is_on_hold = 0 WHERE id = ?', ['resolved', id], (resolveErr) => {
                    if (resolveErr) return res.status(500).json({ error: resolveErr.message });

                    // Cria um novo ticket vazio para o novo atendente
                    const now = getLocalDateTime();
                    const sql = `INSERT INTO tickets (contact_name, contact_number, profile_pic_url, last_message, status, unread_messages, last_message_at, connection_id, queue_id, user_id, is_on_hold)
                                 VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, 0)`;
                    
                    db.run(sql, [
                        ticket.contact_name,
                        ticket.contact_number,
                        ticket.profile_pic_url,
                        'Ticket transferido - novo atendimento',
                        now,
                        ticket.connection_id,
                        queueId,
                        userId || null
                    ], function(insertErr) {
                        if (insertErr) return res.status(500).json({ error: insertErr.message });
                        
                        const newTicketId = this.lastID;
                        const protocolNumber = generateProtocolNumber(newTicketId);
                        
                        // Atualiza o novo ticket com o protocolo
                        db.run('UPDATE tickets SET protocol_number = ? WHERE id = ?', [protocolNumber, newTicketId], (updateErr) => {
                            if (updateErr) logger.error(`Erro ao atualizar protocolo: ${updateErr.message}`);
                            
                            logger.info(`Ticket ${id} resolvido. Novo ticket ${newTicketId} criado com protocolo ${protocolNumber}`);
                            io.emit('ticket_update', { id: id, status: 'resolved' });
                            io.emit('ticket_update', { id: newTicketId, status: 'pending' });
                            
                            res.json({ 
                                message: "Ticket atual resolvido e novo ticket criado com sucesso.",
                                oldTicketId: id,
                                newTicketId: newTicketId,
                                newProtocol: protocolNumber
                            });
                        });
                    });
                });
            });
        } else {
            // Opção 1: Transferir com histórico (comportamento original)
            const sql = `UPDATE tickets 
                         SET queue_id = ?, 
                             user_id = ?, 
                             status = 'pending', 
                             unread_messages = 1,
                             is_on_hold = 0
                         WHERE id = ?`;
            
            db.run(sql, [queueId, userId || null, id], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                io.emit('ticket_update', { id: id, status: 'transferred', transferUserId: transferUserId });
                res.json({ message: "Ticket transferido com sucesso." });
            });
        }
    });
});

// DELETE a ticket and its messages
app.delete('/api/tickets/:id', (req, res) => {
    const { id } = req.params;
    const numericId = parseInt(id, 10);

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // Primeiro, exclui as mensagens associadas ao ticket
        db.run('DELETE FROM messages WHERE ticket_id = ?', [numericId], function(err) {
            if (err) {
                db.run('ROLLBACK');
                logger.error(`Erro ao excluir mensagens do ticket ${numericId}: ${err.message}`);
                return res.status(500).json({ error: "Falha ao excluir mensagens do ticket." });
            }

            // Depois, exclui o próprio ticket
            db.run('DELETE FROM tickets WHERE id = ?', [numericId], function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    logger.error(`Erro ao excluir o ticket ${numericId}: ${err.message}`);
                    return res.status(500).json({ error: "Falha ao excluir o ticket." });
                }
                // Verifica se alguma linha foi realmente deletada
                if (this.changes === 0) {
                    db.run('ROLLBACK');
                    return res.status(404).json({ error: "Ticket não encontrado." });
                }
                db.run('COMMIT');
                io.emit('ticket_update', { id: numericId, status: 'deleted' }); // Notifica os clientes
                res.status(204).send(); // Sucesso, sem conteúdo
            });
        });
    });
});

// GET a single connection by ID
app.get('/api/connections/:id', (req, res) => {
    const { id } = req.params;
    const sqlConnection = "SELECT * FROM connections WHERE id = ?";
    const sqlQueues = "SELECT queue_id FROM connection_queues WHERE connection_id = ?";

    db.get(sqlConnection, [id], (err, connection) => {
        if (err) {
            return res.status(500).json({ "error": err.message });
        }
        if (!connection) {
            return res.status(404).json({ message: "Conexão não encontrada." });
        }

        // Agora, busca as filas associadas
        db.all(sqlQueues, [id], (err, queues) => {
            if (err) {
                return res.status(500).json({ "error": "Falha ao buscar filas da conexão." });
            }
            connection.queue_ids = queues.map(q => q.queue_id);
            res.json(connection);
        });
    });
});

// POST a new connection
app.post('/api/connections', (req, res) => {
    const { name, is_default, start_time, end_time, birthday_message, farewell_message, queue_ids, chatbot_enabled } = req.body;

    if (!name) {
        return res.status(400).json({ "error": "O campo 'nome' é obrigatório." });
    }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        const sql = 'INSERT INTO connections (name, is_default, start_time, end_time, birthday_message, farewell_message, chatbot_enabled, status, last_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)';
        const params = [
            name, 
            is_default ? 1 : 0,
            start_time || null,
            end_time || null,
            birthday_message, 
            farewell_message, 
            chatbot_enabled !== undefined ? (chatbot_enabled ? 1 : 0) : 1,
            'DISCONNECTED'
        ];

        db.run(sql, params, function(err) {
            if (err) {
                db.run('ROLLBACK');
                return res.status(400).json({ "error": err.message });
            }
            const connectionId = this.lastID;

            if (queue_ids && queue_ids.length > 0) {
                const stmt = db.prepare('INSERT INTO connection_queues (connection_id, queue_id) VALUES (?, ?)');
                for (const queue_id of queue_ids) {
                    stmt.run(connectionId, queue_id, (err) => {
                        if (err) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: "Falha ao associar fila à conexão." });
                        }
                    });
                }
                stmt.finalize((err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: "Falha ao finalizar associação de filas." });
                    }
                    db.run('COMMIT');
                    res.status(201).json({ id: connectionId, ...req.body });
                });
            } else {
                db.run('COMMIT');
                res.status(201).json({ id: connectionId, ...req.body });
            }
        });
    });
});

// UPDATE a connection
app.put('/api/connections/:id', (req, res) => {
    const { id } = req.params;
    const { name, is_default, start_time, end_time, birthday_message, farewell_message, queue_ids, chatbot_enabled } = req.body;

    if (!name) {
        return res.status(400).json({ error: "O nome da conexão é obrigatório." });
    }

    // Armazena estado antigo do chatbot (necessário para reenvio se reenab)
    db.get('SELECT chatbot_enabled FROM connections WHERE id = ?', [id], (err, oldRow) => {
        const oldChatbotEnabled = (oldRow && oldRow.chatbot_enabled) || 0;
        const newChatbotEnabled = chatbot_enabled !== undefined ? (chatbot_enabled ? 1 : 0) : oldChatbotEnabled;

        const sql = 'UPDATE connections SET name = ?, is_default = ?, start_time = ?, end_time = ?, birthday_message = ?, farewell_message = ?, chatbot_enabled = ? WHERE id = ?';
        const params = [
            name,
            is_default ? 1 : 0,
            start_time || null,
            end_time || null,
            birthday_message,
            farewell_message,
            newChatbotEnabled,
            id
        ];

        db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            // 1. Atualiza os dados da conexão
            db.run(sql, params, function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(400).json({ "error": err.message });
                }
            });

            // 2. Limpa as associações de fila existentes para esta conexão
            db.run('DELETE FROM connection_queues WHERE connection_id = ?', id);

            // 3. Insere as novas associações (se houver)
            if (queue_ids && queue_ids.length > 0) {
                const stmt = db.prepare('INSERT INTO connection_queues (connection_id, queue_id) VALUES (?, ?)');                for (const queue_id of queue_ids) {
                    stmt.run(id, queue_id);
                }
                stmt.finalize((err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: "Falha ao atualizar associação de filas." });
                    }
                    // Após commit, verifica se chatbot foi reabilitado
                    db.run('COMMIT');
                    handleChatbotReenable(id, oldChatbotEnabled, newChatbotEnabled);
                    res.json({ id: id, ...req.body });
                });
            } else {
                // Após commit, verifica se chatbot foi reabilitado
                db.run('COMMIT');
                handleChatbotReenable(id, oldChatbotEnabled, newChatbotEnabled);
                res.json({ id: id, ...req.body });
            }
        });
    });
});

// Função auxiliar para reenviar mensagem inicial quando chatbot é reabilitado
function handleChatbotReenable(connectionId, oldEnabled, newEnabled) {
    if (oldEnabled === 0 && newEnabled === 1) {
        logger.info(`[Chatbot reenable] Chatbot reabilitado para conexão ${connectionId}. Enviando mensagem inicial para pendentes sem initial_sent.`);

        // Busca contatos pendentes com initial_sent = 0
        db.all('SELECT contact_number FROM pending_queue_selection WHERE connection_id = ? AND initial_sent = 0', [connectionId], (err, rows) => {
            if (err) {
                logger.error(`Erro ao buscar pendentes para reenvio: ${err.message}`);
                return;
            }

            if (!rows || rows.length === 0) {
                logger.info(`[Chatbot reenable] Nenhum contato pendente sem initial_sent para conexão ${connectionId}.`);
                return;
            }

            // Busca dados da conexão (mensagem inicial, horários)
            db.get('SELECT birthday_message, start_time, end_time FROM connections WHERE id = ?', [connectionId], (connErr, connRow) => {
                if (connErr) {
                    logger.warn(`Erro ao buscar dados da conexão ${connectionId}: ${connErr.message}`);
                    return;
                }

                // Verifica horário
                if (connRow && connRow.start_time && connRow.end_time) {
                    if (!isWithinBusinessHours(connRow.start_time, connRow.end_time)) {
                        logger.info(`[Chatbot reenable] Fora do horário (${connRow.start_time} - ${connRow.end_time}). Não reenviando mensagens iniciais para conexão ${connectionId}.`);
                        return;
                    }
                }

                const initialMessage = connRow && connRow.birthday_message ? String(connRow.birthday_message).trim() : null;

                // Busca filas habilitadas
                db.all(`SELECT q.name FROM connection_queues cq JOIN queues q ON cq.queue_id = q.id WHERE cq.connection_id = ? ORDER BY q.name ASC`, [connectionId], async (qErr, qRows) => {
                    if (qErr) {
                        logger.warn(`Erro ao buscar filas para conexão ${connectionId}: ${qErr.message}`);
                        return;
                    }

                    let queuesText = null;
                    if (qRows && qRows.length > 0) {
                        queuesText = 'Por favor, informe *o número* da opção desejada - Ex:(1,2 ou 3...) ' + '\n\n---\n\n';
                        qRows.forEach((row, idx) => {
                            queuesText += `${idx + 1}. ${row.name}` + '\n';
                        });
                    }

                    // Obtém o client WhatsApp
                    const client = sessions[String(connectionId)];
                    if (!client) {
                        logger.warn(`[Chatbot reenable] Cliente WhatsApp não disponível para conexão ${connectionId}.`);
                        return;
                    }

                    // Para cada contato pendente, envia a mensagem inicial
                    for (const row of rows) {
                        const contactNumber = row.contact_number;
                        const contactId = `${contactNumber}@c.us`;

                        (async () => {
                            try {
                                let clientState = null;
                                try { clientState = await client.getState(); } catch (_) {}
                                if (clientState !== 'CONNECTED') {
                                    logger.warn(`[Chatbot reenable] Client não conectado para conexão ${connectionId}.`);
                                    return;
                                }

                                if (initialMessage && initialMessage.length > 0) {
                                    try {
                                        logger.info(`[Chatbot reenable] Enviando mensagem inicial para ${contactNumber}`);
                                        await client.sendMessage(contactId, initialMessage);
                                    } catch (sendErr) {
                                        logger.error(`[Chatbot reenable] Erro ao enviar mensagem inicial para ${contactNumber}: ${sendErr.message}`);
                                    }
                                }

                                if (queuesText) {
                                    try {
                                        logger.info(`[Chatbot reenable] Enviando lista de filas para ${contactNumber}`);
                                        await client.sendMessage(contactId, queuesText);
                                    } catch (sendErr2) {
                                        logger.error(`[Chatbot reenable] Erro ao enviar lista de filas para ${contactNumber}: ${sendErr2.message}`);
                                    }
                                }

                                // Marca initial_sent = 1
                                db.run('UPDATE pending_queue_selection SET initial_sent = 1 WHERE contact_number = ? AND connection_id = ?', [contactNumber, connectionId], (updErr) => {
                                    if (updErr) logger.warn(`Erro ao marcar initial_sent para ${contactNumber}: ${updErr.message}`);
                                });

                            } catch (outerErr) {
                                logger.error(`[Chatbot reenable] Erro ao reenviar para ${contactNumber}: ${outerErr.message}`);
                            }
                        })();
                    }
                });
            });
        });
    }
}

// DELETE a connection
app.delete('/api/connections/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Se existir uma sessão ativa na memória, tenta destruí-la primeiro
        const sessKey = String(id);
        if (sessions[sessKey]) {
            try {
                const clientToClose = sessions[sessKey];
                // A API do client pode expor destroy(), logout() ou close(); tenta destroy() primeiro
                if (typeof clientToClose.destroy === 'function') {
                    await clientToClose.destroy();
                    logger.info(`Sessão WhatsApp para connection ${id} destruída antes da exclusão.`);
                } else if (typeof clientToClose.logout === 'function') {
                    try { await clientToClose.logout(); } catch(e) { /* ignore logout errors */ }
                    logger.info(`Sessão WhatsApp para connection ${id} deslogada antes da exclusão.`);
                }
            } catch (e) {
                logger.warn(`Falha ao encerrar sessão WhatsApp da connection ${id}: ${e && e.message ? e.message : e}`);
            } finally {
                // Remove do mapa de sessões mesmo que destroy falhe (evita referências pendentes)
                try { delete sessions[sessKey]; } catch (e) { /* ignore */ }
            }
        }

        db.run('DELETE FROM connections WHERE id = ?', id, function(err) {
            if (err) {
                return res.status(400).json({ message: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ message: 'Conexão não encontrada.' });
            }

            // Notifica frontends que a conexão foi removida
            try { io.emit('connection_update', { id: parseInt(id, 10), status: 'DELETED' }); } catch (e) { /* ignore */ }

            // Retorna 204 No Content
            return res.status(204).send();
        });
    } catch (err) {
        logger.error(`Erro ao excluir conexão ${id}: ${err && err.message ? err.message : err}`);
        return res.status(500).json({ message: 'Erro interno ao excluir conexão.' });
    }
});

// --- API para Filas (Queues) ---

// GET todas as filas
app.get('/api/queues', (req, res) => {
    db.all("SELECT * FROM queues ORDER BY name ASC", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// GET uma única fila por ID
app.get('/api/queues/:id', (req, res) => {
    const { id } = req.params;
    db.get("SELECT * FROM queues WHERE id = ?", [id], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ message: "Fila não encontrada." });
        }
        res.json(row);
    });
});

// POST para criar uma nova fila
app.post('/api/queues', (req, res) => {
    const { name, color } = req.body;
    if (!name) {
        return res.status(400).json({ error: "O nome da fila é obrigatório." });
    }
    const sql = 'INSERT INTO queues (name, color) VALUES (?, ?)';
    db.run(sql, [name, color], function(err) {
        if (err) {
            if (err.code === 'SQLITE_CONSTRAINT') {
                return res.status(409).json({ error: 'Já existe uma fila com este nome.' });
            }
            return res.status(500).json({ error: err.message });
        }
        res.status(201).json({ id: this.lastID, name, color });
    });
});

// PUT para atualizar uma fila
app.put('/api/queues/:id', (req, res) => {
    const { id } = req.params;
    const { name, color } = req.body;
    if (!name) {
        return res.status(400).json({ error: "O nome da fila é obrigatório." });
    }
    const sql = 'UPDATE queues SET name = ?, color = ? WHERE id = ?';
    db.run(sql, [name, color, id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Fila não encontrada.' });
        }
        res.json({ id: parseInt(id), name, color });
    });
});

// DELETE para excluir uma fila
app.delete('/api/queues/:id', (req, res) => {
    const { id } = req.params;
    // Primeiro, remove associações com usuários e conexões
    db.serialize(() => {
        db.run('DELETE FROM user_queues WHERE queue_id = ?', [id], (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            db.run('DELETE FROM connection_queues WHERE queue_id = ?', [id], (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                // Agora, exclui a fila
                db.run('DELETE FROM queues WHERE id = ?', [id], function(err) {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    if (this.changes === 0) {
                        return res.status(404).json({ error: 'Fila não encontrada.' });
                    }
                    res.json({ message: 'Fila excluída com sucesso.' });
                });
            });
        });
    });
});

// GET - Obter todos os usuários com informações de filas
app.get('/api/users', (req, res) => {
    const sql = `
        SELECT u.id, u.name, u.email, u.profile, u.gender, u.created_at,
               GROUP_CONCAT(uq.queue_id) as queue_ids,
               GROUP_CONCAT(q.name) as queue_names
        FROM users u
        LEFT JOIN user_queues uq ON u.id = uq.user_id
        LEFT JOIN queues q ON uq.queue_id = q.id
        GROUP BY u.id
        ORDER BY u.name
    `;
    db.all(sql, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        // Formata os resultados para incluir arrays de filas
        const users = rows.map(user => ({
            id: user.id,
            name: user.name,
            email: user.email,
            profile: user.profile,
            gender: user.gender || 'neutral',
            created_at: user.created_at,
            queue_ids: user.queue_ids ? user.queue_ids.split(',').map(Number) : [],
            queue_names: user.queue_names ? user.queue_names.split(',') : []
        }));
        res.json(users);
    });
});

// GET - Obter usuários por fila
app.get('/api/queues/:queueId/users', (req, res) => {
    const { queueId } = req.params;
    const sql = `
        SELECT u.id, u.name, u.email, u.profile
        FROM users u
        INNER JOIN user_queues uq ON u.id = uq.user_id
        WHERE uq.queue_id = ?
        ORDER BY u.name
    `;
    db.all(sql, [queueId], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

    // GET - Obter usuários online (apenas usuários com sessão ativa nos últimos 5 minutos)
    app.get('/api/users/online', (req, res) => {
        const sql = `
            SELECT DISTINCT u.id, u.name, u.email, u.profile
            FROM users u
            INNER JOIN user_sessions s ON u.id = s.user_id
            WHERE datetime(s.last_activity) >= datetime('now', '-5 minutes')
            ORDER BY u.name
        `;
        db.all(sql, [], (err, rows) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json(rows);
        });
    });

    // POST - Atualizar atividade do usuário (heartbeat)
    app.post('/api/users/heartbeat', (req, res) => {
        const { userId, sessionToken } = req.body;
    
        if (!userId || !sessionToken) {
            return res.status(400).json({ error: 'userId e sessionToken são obrigatórios' });
        }
    
        const sql = 'UPDATE user_sessions SET last_activity = CURRENT_TIMESTAMP WHERE user_id = ? AND session_token = ?';
    
        db.run(sql, [userId, sessionToken], function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Sessão não encontrada' });
            }
            res.json({ success: true });
        });
    });

    // POST - Fazer logout (remover sessão)
    app.post('/api/users/logout', (req, res) => {
        const { userId, sessionToken } = req.body;
    
        if (!userId || !sessionToken) {
            return res.status(400).json({ error: 'userId e sessionToken são obrigatórios' });
        }
    
        const sql = 'DELETE FROM user_sessions WHERE user_id = ? AND session_token = ?';
    
        db.run(sql, [userId, sessionToken], function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true });
        });
    });

// ============================================
// ROTAS DE API - CHAT INTERNO
// ============================================

// GET - Obter histórico de mensagens com outro usuário
app.get('/api/chat/messages/:otherUserId(\\d+)', (req, res) => {
    const { otherUserId } = req.params;
    const { userId } = req.query;
    
    if (!userId) {
        return res.status(400).json({ error: 'userId é obrigatório' });
    }
    
    // Converter para números
    const userIdNum = parseInt(userId, 10);
    const otherUserIdNum = parseInt(otherUserId, 10);
    
    const sql = `
        SELECT id, from_user_id, to_user_id, message, read_status, created_at
        FROM internal_chat_messages
        WHERE (from_user_id = ? AND to_user_id = ?) 
           OR (from_user_id = ? AND to_user_id = ?)
        ORDER BY created_at DESC
        LIMIT 100
    `;
    
    db.all(sql, [userIdNum, otherUserIdNum, otherUserIdNum, userIdNum], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// GET - Obter contagem de mensagens não lidas por remetente
app.get('/api/chat/unread-counts', (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ error: 'userId é obrigatório' });
    }

    const sql = `
        SELECT from_user_id AS user_id, COUNT(*) AS count
        FROM internal_chat_messages
        WHERE to_user_id = ? AND read_status = 0
        GROUP BY from_user_id
    `;

    db.all(sql, [userId], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// POST - Enviar mensagem para outro usuário
app.post('/api/chat/messages', (req, res) => {
    const { fromUserId, toUserId, message } = req.body;
    
    if (!fromUserId || !toUserId || !message) {
        return res.status(400).json({ error: 'fromUserId, toUserId e message são obrigatórios' });
    }
    
    const sql = 'INSERT INTO internal_chat_messages (from_user_id, to_user_id, message) VALUES (?, ?, ?)';
    
    db.run(sql, [fromUserId, toUserId, message], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        const newMessage = {
            id: this.lastID,
            from_user_id: fromUserId,
            to_user_id: toUserId,
            message: message,
            read_status: 0,
            created_at: new Date().toISOString()
        };
        
        // Emitir evento via Socket.io para o destinatário
        io.emit(`chat_message_${toUserId}`, newMessage);
        
        res.json(newMessage);
    });
});

// PUT - Marcar mensagens como lidas
app.put('/api/chat/messages/read', (req, res) => {
    const { userId, otherUserId } = req.body;
    
    if (!userId || !otherUserId) {
        return res.status(400).json({ error: 'userId e otherUserId são obrigatórios' });
    }
    
    const sql = 'UPDATE internal_chat_messages SET read_status = 1 WHERE from_user_id = ? AND to_user_id = ? AND read_status = 0';
    
    db.run(sql, [otherUserId, userId], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, updated: this.changes });
    });
});

// GET - Obter um usuário específico
app.get('/api/users/:id(\\d+)', (req, res) => {
    const { id } = req.params;
    const sql = `
        SELECT u.id, u.name, u.email, u.profile, u.gender, u.created_at,
               GROUP_CONCAT(uq.queue_id) as queue_ids
        FROM users u
        LEFT JOIN user_queues uq ON u.id = uq.user_id
        WHERE u.id = ?
        GROUP BY u.id
    `;
    db.get(sql, [id], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }
        const user = {
            id: row.id,
            name: row.name,
            email: row.email,
            profile: row.profile,
            gender: row.gender || 'neutral',
            created_at: row.created_at,
            queue_ids: row.queue_ids ? row.queue_ids.split(',').map(Number) : []
        };

        // Buscar nomes das filas associadas
        const queueSql = `
            SELECT q.id, q.name
            FROM queues q
            INNER JOIN user_queues uq ON q.id = uq.queue_id
            WHERE uq.user_id = ?
            ORDER BY q.name ASC
        `;
        db.all(queueSql, [id], (qErr, queues) => {
            if (qErr) {
                return res.status(500).json({ error: qErr.message });
            }
            res.json({ ...user, queues: queues || [] });
        });
    });
});

// POST - Criar um novo usuário
app.post('/api/users', async (req, res) => {
    const { name, email, password, profile, queue_ids, gender } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Nome, email e senha são obrigatórios.' });
    }

    // Valida formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Email inválido.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Gera token de verificação
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const tokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas
        
        const sql = `INSERT INTO users (name, email, password, profile, gender, email_verified, verification_token, verification_token_expires) 
                     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`;
        
        db.run(sql, [name, email, hashedPassword, profile || 'user', gender || 'neutral', verificationToken, tokenExpires.toISOString()], async function(err) {
            if (err) {
                if (err.code === 'SQLITE_CONSTRAINT') {
                    return res.status(409).json({ error: 'Este email já está cadastrado.' });
                }
                logger.error(`Erro ao criar usuário: ${err.message}`);
                return res.status(500).json({ error: err.message });
            }
            
            const userId = this.lastID;
            
            // Associar filas ao usuário
            if (queue_ids && queue_ids.length > 0) {
                const insertQueue = db.prepare('INSERT INTO user_queues (user_id, queue_id) VALUES (?, ?)');
                queue_ids.forEach(queueId => {
                    insertQueue.run(userId, queueId);
                });
                insertQueue.finalize();
            }
            
            // Envia email de verificação
            try {
                await sendVerificationEmail(email, name, verificationToken);
                res.status(201).json({ 
                    message: 'Usuário criado com sucesso! Verifique seu email para ativar a conta.', 
                    id: userId,
                    name,
                    email,
                    profile: profile || 'user',
                    emailSent: true
                });
            } catch (emailError) {
                logger.error('Erro ao enviar email de verificação:', emailError);
                res.status(201).json({ 
                    message: 'Usuário criado, mas houve erro ao enviar email de verificação. Contate o administrador.', 
                    id: userId,
                    name,
                    email,
                    profile: profile || 'user',
                    emailSent: false
                });
            }
        });
    } catch (error) {
        logger.error(`Erro ao criar usuário: ${error.message}`);
        res.status(500).json({ error: 'Erro no servidor ao criar usuário.' });
    }
});

// GET - Verificar email através do token
app.get('/verify-email', (req, res) => {
    const { token } = req.query;
    
    if (!token) {
        return res.status(400).send(`
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Erro - Verificação de Email</title>
                <style>
                    body { font-family: Arial, sans-serif; background-color: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                    .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
                    .error { color: #dc3545; }
                    h1 { margin-bottom: 20px; }
                    a { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1 class="error">❌ Token inválido</h1>
                    <p>O link de verificação está incompleto ou inválido.</p>
                    <a href="/index.html">Voltar ao Login</a>
                </div>
            </body>
            </html>
        `);
    }
    
    const sql = `SELECT * FROM users WHERE verification_token = ?`;
    
    db.get(sql, [token], (err, user) => {
        if (err) {
            logger.error(`Erro ao verificar token: ${err.message}`);
            return res.status(500).send(`
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Erro - Verificação de Email</title>
                    <style>
                        body { font-family: Arial, sans-serif; background-color: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
                        .error { color: #dc3545; }
                        h1 { margin-bottom: 20px; }
                        a { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1 class="error">❌ Erro no servidor</h1>
                        <p>Ocorreu um erro ao processar sua verificação. Por favor, tente novamente mais tarde.</p>
                        <a href="/index.html">Voltar ao Login</a>
                    </div>
                </body>
                </html>
            `);
        }
        
        if (!user) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Erro - Verificação de Email</title>
                    <style>
                        body { font-family: Arial, sans-serif; background-color: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
                        .error { color: #dc3545; }
                        h1 { margin-bottom: 20px; }
                        a { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1 class="error">❌ Token não encontrado</h1>
                        <p>Este link de verificação não é válido ou já foi usado.</p>
                        <a href="/index.html">Voltar ao Login</a>
                    </div>
                </body>
                </html>
            `);
        }
        
        // Verificar se o token expirou
        const tokenExpires = new Date(user.verification_token_expires);
        if (tokenExpires < new Date()) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Token Expirado - Verificação de Email</title>
                    <style>
                        body { font-family: Arial, sans-serif; background-color: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
                        .error { color: #dc3545; }
                        h1 { margin-bottom: 20px; }
                        p { margin: 10px 0; }
                        a { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; transition: background 0.3s; }
                        a:hover { background: #218838; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1 class="error">⏰ Token expirado</h1>
                        <p>Este link de verificação expirou (validade: 24 horas).</p>
                        <p>Por favor, contate o administrador para receber um novo link de verificação.</p>
                        <a href="/index.html">Voltar ao Login</a>
                    </div>
                </body>
                </html>
            `);
        }
        
        // Verificar se já está verificado
        if (user.email_verified === 1) {
            return res.status(200).send(`
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Email Já Verificado</title>
                    <style>
                        body { font-family: Arial, sans-serif; background-color: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
                        .success { color: #28a745; }
                        h1 { margin-bottom: 20px; }
                        a { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1 class="success">✅ Email já verificado</h1>
                        <p>Sua conta já está ativa!</p>
                        <p>Você pode fazer login normalmente.</p>
                        <a href="/index.html">Ir para o Login</a>
                    </div>
                </body>
                </html>
            `);
        }
        
        // Ativar a conta
        const updateSql = `UPDATE users SET email_verified = 1, verification_token = NULL, verification_token_expires = NULL WHERE id = ?`;
        
        db.run(updateSql, [user.id], (err) => {
            if (err) {
                logger.error(`Erro ao ativar conta: ${err.message}`);
                return res.status(500).send(`
                    <!DOCTYPE html>
                    <html lang="pt-BR">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Erro - Verificação de Email</title>
                        <style>
                            body { font-family: Arial, sans-serif; background-color: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                            .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
                            .error { color: #dc3545; }
                            h1 { margin-bottom: 20px; }
                            a { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <h1 class="error">❌ Erro ao ativar conta</h1>
                            <p>Ocorreu um erro ao ativar sua conta. Por favor, contate o administrador.</p>
                            <a href="/index.html">Voltar ao Login</a>
                        </div>
                    </body>
                    </html>
                `);
            }
            
            logger.info(`Conta verificada com sucesso: ${user.email}`);
            
            res.status(200).send(`
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Email Verificado com Sucesso!</title>
                    <style>
                        body { font-family: Arial, sans-serif; background-color: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
                        .success { color: #28a745; }
                        h1 { margin-bottom: 20px; }
                        p { margin: 10px 0; color: #666; }
                        a { display: inline-block; margin-top: 20px; padding: 12px 30px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; transition: background 0.3s; }
                        a:hover { background: #218838; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1 class="success">✅ Email verificado com sucesso!</h1>
                        <p>Bem-vindo, <strong>${user.name}</strong>!</p>
                        <p>Sua conta foi ativada e você já pode fazer login no sistema.</p>
                        <a href="/index.html">Fazer Login Agora</a>
                    </div>
                </body>
                </html>
            `);
        });
    });
});

// Reenvio de email de verificação
app.post('/api/resend-verification', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: 'Email é obrigatório.' });
    }
    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err) {
            logger.error('Erro ao buscar usuário para reenvio:', err);
            return res.status(500).json({ error: 'Erro ao buscar usuário.' });
        }
        if (!user) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }
        if (user.email_verified === 1) {
            return res.status(400).json({ error: 'Este email já está verificado.' });
        }
        // Gera novo token e expiração
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const tokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
        db.run('UPDATE users SET verification_token = ?, verification_token_expires = ? WHERE id = ?',
            [verificationToken, tokenExpires.toISOString(), user.id], async (err) => {
                if (err) {
                    logger.error('Erro ao atualizar token de verificação:', err);
                    return res.status(500).json({ error: 'Erro ao atualizar token.' });
                }
                try {
                    await sendVerificationEmail(user.email, user.name, verificationToken);
                    res.json({ message: 'Email de verificação reenviado com sucesso!' });
                } catch (emailError) {
                    logger.error('Erro ao reenviar email de verificação:', emailError);
                    res.status(500).json({ error: 'Erro ao enviar email de verificação.' });
                }
            });
    });
});

// PUT - Atualizar um usuário
app.put('/api/users/:id(\\d+)', async (req, res) => {
    const { id } = req.params;
    const { name, email, password, profile, queue_ids, gender } = req.body;

    if (!name || !email) {
        return res.status(400).json({ error: 'Nome e email são obrigatórios.' });
    }

    try {
        let sql, params;
        
        // Se houver senha, atualiza com senha
        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            sql = 'UPDATE users SET name = ?, email = ?, password = ?, profile = ?, gender = ? WHERE id = ?';
            params = [name, email, hashedPassword, profile || 'user', gender || 'neutral', id];
        } else {
            // Sem senha, mantém a atual
            sql = 'UPDATE users SET name = ?, email = ?, profile = ?, gender = ? WHERE id = ?';
            params = [name, email, profile || 'user', gender || 'neutral', id];
        }
        
        db.run(sql, params, function(err) {
            if (err) {
                if (err.code === 'SQLITE_CONSTRAINT') {
                    return res.status(409).json({ error: 'Este email já está cadastrado.' });
                }
                return res.status(500).json({ error: err.message });
            }
            
            // Atualizar filas do usuário
            db.run('DELETE FROM user_queues WHERE user_id = ?', [id], (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                
                if (queue_ids && queue_ids.length > 0) {
                    const insertQueue = db.prepare('INSERT INTO user_queues (user_id, queue_id) VALUES (?, ?)');
                    queue_ids.forEach(queueId => {
                        insertQueue.run(id, queueId);
                    });
                    insertQueue.finalize();
                }
                
                res.json({ message: 'Usuário atualizado com sucesso!', id });
            });
        });
    } catch (error) {
        logger.error(`Erro ao atualizar usuário: ${error.message}`);
        res.status(500).json({ error: 'Erro no servidor ao atualizar usuário.' });
    }
});

// DELETE - Excluir um usuário
app.delete('/api/users/:id(\\d+)', (req, res) => {
    const { id } = req.params;
    
    // Primeiro remove as associações com filas
    db.run('DELETE FROM user_queues WHERE user_id = ?', [id], (err) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        // Depois remove o usuário
        db.run('DELETE FROM users WHERE id = ?', [id], function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Usuário não encontrado.' });
            }
            res.status(204).send();
        });
    });
});

// --- Permissions Management Routes ---

// GET - Obter todas as permissões
app.get('/api/permissions', (req, res) => {
    const sql = `
        SELECT profile, module, can_view
        FROM permissions
        ORDER BY 
            CASE profile 
                WHEN 'admin' THEN 1 
                WHEN 'supervisor' THEN 2 
                WHEN 'usuario' THEN 3 
            END,
            module
    `;
    
    db.all(sql, [], (err, rows) => {
        if (err) {
            logger.error(`Erro ao buscar permissões: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }
        
        // Agrupar por perfil para facilitar no frontend
        const grouped = {};
        rows.forEach(row => {
            if (!grouped[row.profile]) {
                grouped[row.profile] = [];
            }
            grouped[row.profile].push({
                module: row.module,
                can_view: row.can_view === 1
            });
        });
        
        res.json(grouped);
    });
});

// GET - Obter permissões de um perfil específico
app.get('/api/permissions/:profile', (req, res) => {
    const { profile } = req.params;
    
    const sql = 'SELECT module, can_view FROM permissions WHERE profile = ? ORDER BY module';
    
    db.all(sql, [profile], (err, rows) => {
        if (err) {
            logger.error(`Erro ao buscar permissões do perfil ${profile}: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }
        
        const permissions = rows.map(row => ({
            module: row.module,
            can_view: row.can_view === 1
        }));
        
        res.json(permissions);
    });
});

// PUT - Atualizar permissões de um perfil
app.put('/api/permissions/:profile', (req, res) => {
    const { profile } = req.params;
    const { permissions } = req.body;
    
    if (!permissions || !Array.isArray(permissions)) {
        return res.status(400).json({ error: 'Permissões inválidas. Esperado um array.' });
    }
    
    // Validar perfil
    const validProfiles = ['admin', 'supervisor', 'usuario'];
    if (!validProfiles.includes(profile)) {
        return res.status(400).json({ error: 'Perfil inválido.' });
    }
    
    // Admin não pode ter suas permissões modificadas
    if (profile === 'admin') {
        return res.status(403).json({ error: 'Não é permitido modificar permissões do perfil Admin.' });
    }
    
    // Iniciar transação para garantir atomicidade
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        let hasError = false;
        let completed = 0;
        const total = permissions.length;
        
        if (total === 0) {
            db.run('COMMIT');
            return res.json({ message: 'Nenhuma permissão para atualizar.' });
        }
        
        permissions.forEach(perm => {
            const sql = `
                UPDATE permissions 
                SET can_view = ?, updated_at = CURRENT_TIMESTAMP 
                WHERE profile = ? AND module = ?
            `;
            
            db.run(sql, [
                perm.can_view ? 1 : 0,
                profile,
                perm.module
            ], function(err) {
                if (err && !hasError) {
                    hasError = true;
                    logger.error(`Erro ao atualizar permissão ${perm.module} para ${profile}: ${err.message}`);
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: err.message });
                }
                
                completed++;
                
                // Se todas as atualizações foram concluídas
                if (completed === total && !hasError) {
                    db.run('COMMIT', (commitErr) => {
                        if (commitErr) {
                            logger.error(`Erro ao fazer commit das permissões: ${commitErr.message}`);
                            return res.status(500).json({ error: commitErr.message });
                        }
                        
                        logger.info(`Permissões do perfil ${profile} atualizadas com sucesso.`);
                        res.json({ 
                            message: `Permissões do perfil ${profile} atualizadas com sucesso!`,
                            updated: total
                        });
                    });
                }
            });
        });
    });
});

// GET - Obter permissões do usuário logado (baseado em seu perfil)
app.get('/api/user-permissions', (req, res) => {
    const sessionToken = req.query.sessionToken || req.headers['x-session-token'];
    
    if (!sessionToken) {
        return res.status(401).json({ error: 'Token de sessão não fornecido.' });
    }
    
    // Buscar usuário pela sessão
    db.get('SELECT user_id FROM user_sessions WHERE session_token = ?', [sessionToken], (err, session) => {
        if (err) {
            logger.error(`Erro ao buscar sessão: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }
        
        if (!session) {
            return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
        }
        
        // Buscar perfil do usuário
        db.get('SELECT profile FROM users WHERE id = ?', [session.user_id], (userErr, user) => {
            if (userErr) {
                logger.error(`Erro ao buscar usuário: ${userErr.message}`);
                return res.status(500).json({ error: userErr.message });
            }
            
            if (!user) {
                return res.status(404).json({ error: 'Usuário não encontrado.' });
            }

            // Normaliza o perfil para garantir correspondência com a tabela de permissões
            const normalizeProfile = (p) => {
                if (!p) return '';
                let s = String(p).trim().toLowerCase();
                // remove acentos
                s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                // mapear sinônimos
                if (s === 'administrador' || s === 'admin') return 'admin';
                if (s === 'supervisor') return 'supervisor';
                if (s === 'usuario' || s === 'utilizador' || s === 'user' || s === 'usuari') return 'usuario';
                return s;
            };

            const normalizedProfile = normalizeProfile(user.profile);

            // Buscar permissões do perfil normalizado
            const sql = 'SELECT module, can_view FROM permissions WHERE profile = ?';
            db.all(sql, [normalizedProfile], (permErr, permissions) => {
                if (permErr) {
                    logger.error(`Erro ao buscar permissões: ${permErr.message}`);
                    return res.status(500).json({ error: permErr.message });
                }
                
                const formattedPermissions = {};
                permissions.forEach(perm => {
                    formattedPermissions[perm.module] = {
                        can_view: perm.can_view === 1
                    };
                });
                
                res.json({
                    profile: normalizedProfile,
                    permissions: formattedPermissions
                });
            });
        });
    });
});

// PUT - Alterar senha do usuário (perfil)
app.put('/api/users/:id(\\d+)/password', async (req, res) => {
    const userId = req.params.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ 
            success: false, 
            message: 'Senha atual e nova senha são obrigatórias.' 
        });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ 
            success: false, 
            message: 'A nova senha deve ter pelo menos 6 caracteres.' 
        });
    }

    // Buscar usuário
    const sql = 'SELECT * FROM users WHERE id = ?';
    db.get(sql, [userId], async (err, user) => {
        if (err) {
            logger.error(`Erro ao buscar usuário: ${err.message}`);
            return res.status(500).json({ 
                success: false, 
                message: 'Erro no servidor.' 
            });
        }
        if (!user) {
            return res.status(404).json({ 
                success: false, 
                message: 'Usuário não encontrado.' 
            });
        }

        // Verificar senha atual
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(401).json({ 
                success: false, 
                message: 'Senha atual incorreta.' 
            });
        }

        // Hash da nova senha
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Atualizar senha
        const updateSql = 'UPDATE users SET password = ? WHERE id = ?';
        db.run(updateSql, [hashedPassword, userId], function(err) {
            if (err) {
                logger.error(`Erro ao atualizar senha: ${err.message}`);
                return res.status(500).json({ 
                    success: false, 
                    message: 'Erro ao atualizar senha.' 
                });
            }

            logger.info(`Senha alterada para usuário ID: ${userId}`);
            res.json({ 
                success: true, 
                message: 'Senha alterada com sucesso!' 
            });
        });
    });
});

// Rota para registrar um novo usuário (mantida para compatibilidade)
app.post('/api/register', async (req, res) => {
    const { name, email, password } = req.body;

    // Validações
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Nome, email e senha são obrigatórios.' });
    }

    if (name.length < 3) {
        return res.status(400).json({ error: 'O nome deve ter pelo menos 3 caracteres.' });
    }

    // Validar formato do email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Email inválido.' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Gera token de verificação
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const tokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas
        
        const sql = `INSERT INTO users (name, email, password, profile, email_verified, verification_token, verification_token_expires) 
                     VALUES (?, ?, ?, ?, 0, ?, ?)`;
        
        db.run(sql, [name, email, hashedPassword, 'user', verificationToken, tokenExpires.toISOString()], async function(err) {
            if (err) {
                if (err.code === 'SQLITE_CONSTRAINT') {
                    return res.status(409).json({ error: 'Este email já está cadastrado.' });
                }
                logger.error(`Erro ao registrar usuário: ${err.message}`);
                return res.status(500).json({ error: 'Erro ao registrar usuário.' });
            }
            
            const userId = this.lastID;
            logger.info(`Novo usuário registrado: ${email} (ID: ${userId})`);
            
            // Envia email de verificação
            try {
                await sendVerificationEmail(email, name, verificationToken);
                res.status(201).json({ 
                    message: 'Conta criada com sucesso! Verifique seu email para ativar.', 
                    userId,
                    name,
                    email,
                    emailSent: true
                });
            } catch (emailError) {
                logger.error('Erro ao enviar email de verificação:', emailError);
                res.status(201).json({ 
                    message: 'Conta criada, mas houve erro ao enviar email de verificação. Contate o administrador.', 
                    userId,
                    name,
                    email,
                    emailSent: false
                });
            }
        });
    } catch (error) {
        logger.error(`Erro ao registrar usuário: ${error.message}`);
        res.status(500).json({ error: 'Erro no servidor ao tentar registrar.' });
    }
});

// === ENDPOINTS DE CONTATOS ===

// Helper: resolve user_id from request using session token (query or header)
function resolveUserIdFromRequest(req, cb) {
    const sessionToken = req.query.sessionToken || req.headers['x-session-token'];
    if (!sessionToken) return cb(null);
    db.get('SELECT user_id FROM user_sessions WHERE session_token = ?', [sessionToken], (err, row) => {
        if (err) {
            logger.warn(`Falha ao resolver sessionToken: ${err.message}`);
            return cb(null);
        }
        return cb(row ? row.user_id : null);
    });
}

// Migração defensiva: garantir tabela `contacts` e coluna `created_by` para controle de visibilidade
db.run(`CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    profile_pic_url TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
)`);

db.all("PRAGMA table_info('contacts')", (err, cols) => {
    if (err) {
        logger.warn(`Falha ao inspecionar tabela contacts: ${err.message}`);
        return;
    }
    const hasCreatedBy = Array.isArray(cols) && cols.some(c => c.name === 'created_by');
    if (!hasCreatedBy) {
        db.run("ALTER TABLE contacts ADD COLUMN created_by INTEGER", (alterErr) => {
            if (alterErr) logger.warn(`Falha ao adicionar coluna created_by em contacts: ${alterErr.message}`);
            else logger.info('Coluna created_by adicionada à tabela contacts.');
        });
    }
});

// Migração: se existir um índice único apenas na coluna `phone`, recria a tabela sem UNIQUE
db.all("PRAGMA index_list('contacts')", (idxErr, indexes) => {
    if (idxErr || !Array.isArray(indexes) || indexes.length === 0) return;
    let needsMigration = false;
    const candidateIndexes = indexes.filter(i => i.unique);
    if (candidateIndexes.length === 0) return;

    // Verifica se existe um índice único cuja coluna é apenas 'phone'
    (function checkNext(i) {
        if (i >= candidateIndexes.length) {
            if (needsMigration) {
                logger.info('Iniciando migração para remover UNIQUE(phone) em contacts...');
                db.serialize(() => {
                    db.run('BEGIN TRANSACTION');
                    db.run(`CREATE TABLE IF NOT EXISTS contacts_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT NOT NULL,
                        phone TEXT NOT NULL,
                        profile_pic_url TEXT,
                        created_by INTEGER,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
                    )`);
                    db.run(`INSERT INTO contacts_new (id, name, phone, profile_pic_url, created_by, created_at, updated_at)
                            SELECT id, name, phone, profile_pic_url, created_by, created_at, updated_at FROM contacts`);
                    db.run('DROP TABLE contacts');
                    db.run('ALTER TABLE contacts_new RENAME TO contacts');
                    db.run('COMMIT');
                    logger.info('Migração de contacts concluída (UNIQUE phone removido).');
                });
            }
            return;
        }

        const idx = candidateIndexes[i];
        db.all("PRAGMA index_info('" + idx.name + "')", (infoErr, cols) => {
            if (!infoErr && Array.isArray(cols) && cols.length === 1 && cols[0].name === 'phone') {
                needsMigration = true;
            }
            checkNext(i + 1);
        });
    })(0);
});

// GET - Listar contatos visíveis para o agente (contatos globais + contatos criados pelo agente)
app.get('/api/contacts', (req, res) => {
    resolveUserIdFromRequest(req, (userId) => {
        let sql, params;
        if (userId) {
            sql = 'SELECT * FROM contacts WHERE created_by IS NULL OR created_by = ? ORDER BY name ASC';
            params = [userId];
        } else {
            sql = 'SELECT * FROM contacts ORDER BY name ASC';
            params = [];
        }
        db.all(sql, params, (err, rows) => {
            if (err) {
                logger.error(`Erro ao buscar contatos: ${err.message}`);
                return res.status(500).json({ error: err.message });
            }
            res.json(rows || []);
        });
    });
});

// GET - Obter contato por ID
app.get('/api/contacts/:id(\\d+)', (req, res) => {
    const id = parseInt(req.params.id);
    resolveUserIdFromRequest(req, (requesterId) => {
        db.get('SELECT * FROM contacts WHERE id = ?', [id], (err, row) => {
            if (err) {
                logger.error(`Erro ao buscar contato por ID: ${err.message}`);
                return res.status(500).json({ error: err.message });
            }
            if (!row) {
                return res.status(404).json({ error: 'Contato não encontrado.' });
            }
            if (row.created_by && requesterId && row.created_by !== requesterId) {
                return res.status(403).json({ error: 'Você não tem permissão para visualizar este contato.' });
            }
            if (row.created_by && !requesterId) {
                return res.status(403).json({ error: 'Você não tem permissão para visualizar este contato.' });
            }
            res.json(row);
        });
    });
});

// POST - Criar um novo contato
app.post('/api/contacts', (req, res) => {
    const { name, phone, profile_pic_url, info, user_id, created_by } = req.body;

    if (!name || !phone) {
        return res.status(400).json({ error: 'Nome e telefone são obrigatórios.' });
    }

    const profileUrl = profile_pic_url || info || null;

    // resolve owner id from session token if available, fallback to provided user_id/created_by
    resolveUserIdFromRequest(req, (resolvedUserId) => {
        const ownerId = created_by || user_id || resolvedUserId || null;

        const sql = 'INSERT INTO contacts (name, phone, profile_pic_url, created_by) VALUES (?, ?, ?, ?)';
        db.run(sql, [name, phone, profileUrl, ownerId], function(err) {
            if (err) {
                if (err.code === 'SQLITE_CONSTRAINT') {
                    return res.status(409).json({ error: 'Este telefone já está cadastrado.' });
                }
                logger.error(`Erro ao criar contato: ${err.message}`);
                return res.status(500).json({ error: err.message });
            }

            logger.info(`Novo contato criado: ${name} (${phone})`);
            res.status(201).json({
                id: this.lastID,
                name,
                phone,
                profile_pic_url: profileUrl,
                created_by: ownerId,
                created_at: getLocalDateTime(),
                updated_at: getLocalDateTime()
            });
        });
    });
});

// PUT - Atualizar contato
app.put('/api/contacts/:id(\\d+)', (req, res) => {
    const id = parseInt(req.params.id);
    const { name, phone, profile_pic_url, info, user_id } = req.body;
    const requesterId = user_id || (req.query && req.query.user_id ? parseInt(req.query.user_id) : null);

    if (!name || !phone) {
        return res.status(400).json({ error: 'Nome e telefone são obrigatórios.' });
    }

    // Check ownership: only creator (created_by) or global (created_by IS NULL) can be updated by requester
    db.get('SELECT * FROM contacts WHERE id = ?', [id], (err, existing) => {
        if (err) {
            logger.error(`Erro ao buscar contato antes de atualizar: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }
        if (!existing) return res.status(404).json({ error: 'Contato não encontrado.' });
        if (existing.created_by && requesterId && existing.created_by !== requesterId) {
            return res.status(403).json({ error: 'Você não tem permissão para atualizar este contato.' });
        }

        const profileUrl = profile_pic_url || info || null;
        const sql = 'UPDATE contacts SET name = ?, phone = ?, profile_pic_url = ?, updated_at = ? WHERE id = ?';
        db.run(sql, [name, phone, profileUrl, getLocalDateTime(), id], function(err) {
            if (err) {
                if (err.code === 'SQLITE_CONSTRAINT') {
                    return res.status(409).json({ error: 'Este telefone já está cadastrado.' });
                }
                logger.error(`Erro ao atualizar contato: ${err.message}`);
                return res.status(500).json({ error: err.message });
            }

            if (this.changes === 0) {
                return res.status(404).json({ error: 'Contato não encontrado.' });
            }

            logger.info(`Contato atualizado: ID ${id}`);
            res.json({ message: 'Contato atualizado com sucesso.' });
        });
    });
});

// DELETE - Remover contato
app.delete('/api/contacts/:id(\\d+)', (req, res) => {
    const id = parseInt(req.params.id);

    resolveUserIdFromRequest(req, (requesterId) => {
        // Only allow deletion if contact is global (created_by IS NULL) or requester is the creator
        db.get('SELECT * FROM contacts WHERE id = ?', [id], (err, existing) => {
            if (err) {
                logger.error(`Erro ao buscar contato antes de deletar: ${err.message}`);
                return res.status(500).json({ error: err.message });
            }
            if (!existing) return res.status(404).json({ error: 'Contato não encontrado.' });
            if (existing.created_by && requesterId && existing.created_by !== requesterId) {
                return res.status(403).json({ error: 'Você não tem permissão para deletar este contato.' });
            }
            if (existing.created_by && !requesterId) {
                return res.status(403).json({ error: 'Você não tem permissão para deletar este contato.' });
            }

            const sql = 'DELETE FROM contacts WHERE id = ?';
            db.run(sql, [id], function(err) {
                if (err) {
                    logger.error(`Erro ao deletar contato: ${err.message}`);
                    return res.status(500).json({ error: err.message });
                }

                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Contato não encontrado.' });
                }

                logger.info(`Contato deletado: ID ${id}`);
                res.json({ message: 'Contato removido com sucesso.' });
            });
        });
    });
});

// POST - Iniciar atendimento a partir de um contato
app.post('/api/contacts/:id(\\d+)/initiate-ticket', (req, res) => {
    const contactId = parseInt(req.params.id);
    const { userId, connectionId, queueId } = req.body;

    // Buscar informações do contato
    db.get('SELECT * FROM contacts WHERE id = ?', [contactId], (err, contact) => {
        if (err) {
            logger.error(`Erro ao buscar contato: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }

        if (!contact) {
            return res.status(404).json({ error: 'Contato não encontrado.' });
        }



        // Permitir que cada agente (user_id) tenha seu próprio ticket ativo para o mesmo contato
        db.get('SELECT id FROM tickets WHERE contact_number = ? AND user_id = ? AND (status = "pending" OR status = "attending")', [contact.phone, userId], (ticketErr, existingTicket) => {
            if (ticketErr) {
                logger.error(`Erro ao verificar ticket existente: ${ticketErr.message}`);
                return res.status(500).json({ error: ticketErr.message });
            }

            if (existingTicket) {
                return res.status(409).json({ error: 'Já existe um atendimento ativo para este contato e agente.' });
            }

            // Criar novo ticket
            const messageTime = getLocalDateTime();
            const sql = `INSERT INTO tickets (contact_name, contact_number, profile_pic_url, last_message, status, unread_messages, last_message_at, connection_id, is_on_hold, queue_id, user_id, is_manual) VALUES (?, ?, ?, ?, 'attending', 0, ?, ?, 0, ?, ?, 1)`;
            db.run(sql, [contact.name, contact.phone, contact.profile_pic_url, '[Atendimento iniciado manualmente]', messageTime, connectionId || null, queueId || null, userId || null], function(ticketInsertErr) {
                if (ticketInsertErr) {
                    logger.error(`Erro ao criar ticket: ${ticketInsertErr.message}`);
                    return res.status(500).json({ error: ticketInsertErr.message });
                }

                const newTicketId = this.lastID;
                const protocolNumber = generateProtocolNumber(newTicketId);

                // Atualiza o ticket com o protocolo
                db.run('UPDATE tickets SET protocol_number = ? WHERE id = ?', [protocolNumber, newTicketId], (updateErr) => {
                    if (updateErr) {
                        logger.error(`Erro ao atualizar protocolo: ${updateErr.message}`);
                    }
                });

                // Criar mensagem inicial
                db.run('INSERT INTO messages (ticket_id, body, sender, timestamp) VALUES (?, ?, ?, ?)',
                    [newTicketId, '[Atendimento iniciado manualmente]', 'system', messageTime],
                    function(msgErr) {
                        if (!msgErr) {
                            // Emite evento de nova mensagem
                            io.emit('new-message', {
                                id: this.lastID,
                                ticket_id: newTicketId,
                                body: '[Atendimento iniciado manualmente]',
                                sender: 'system',
                                timestamp: messageTime
                            });
                        }
                    }
                );

                // Emitir evento de atualização do ticket
                io.emit('ticket_update', { id: newTicketId, status: 'attending' });

                logger.info(`Atendimento iniciado manualmente para contato ${contact.name} (${contact.phone}) - Ticket ID: ${newTicketId}`);
                res.status(201).json({
                    ticketId: newTicketId,
                    protocolNumber,
                    message: 'Atendimento iniciado com sucesso.'
                });
            });
        });
    });
});

// Rota para fazer login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: 'Email, nome ou senha são obrigatórios.' });
    }

    // (rotas de perfil foram definidas no escopo superior)

    // Buscar por email OU nome
    const sql = 'SELECT * FROM users WHERE email = ? OR name = ?';
    db.get(sql, [username, username], async (err, user) => {
        if (err) {
            logger.error(`Erro no DB ao buscar usuário: ${err.message}`);
            return res.status(500).json({ message: 'Erro no servidor.', error: err.message });
        }
        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        // Verificar se o email foi verificado
        if (user.email_verified === 0) {
            return res.status(403).json({ 
                message: 'Email não verificado. Por favor, verifique seu email antes de fazer login.',
                emailNotVerified: true
            });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Senha incorreta.' });
        }

        // Buscar as filas (departamentos) do usuário
        db.all('SELECT queue_id FROM user_queues WHERE user_id = ?', [user.id], (err, queues) => {
            const queueIds = queues && queues.length > 0 ? queues.map(q => q.queue_id) : [];
            
            // Criar sessão de usuário online
            const sessionToken = crypto.randomBytes(32).toString('hex');
            const insertSessionSql = 'INSERT INTO user_sessions (user_id, session_token, last_activity) VALUES (?, ?, CURRENT_TIMESTAMP)';
            
            db.run(insertSessionSql, [user.id, sessionToken], (sessionErr) => {
                if (sessionErr) {
                    logger.error(`Erro ao criar sessão: ${sessionErr.message}`);
                }
                
                res.status(200).json({ 
                    message: 'Login bem-sucedido!',
                    user: {
                        id: user.id,
                        name: user.name,
                        email: user.email,
                        profile: user.profile,
                        gender: user.gender || 'neutral',
                        queue_ids: queueIds
                    },
                    sessionToken: sessionToken
                });
            });
        });
    });
});

// === ENDPOINTS DO CHATBOT ===

// GET /api/chatbot/config - Buscar configuração atual do chatbot
app.get('/api/chatbot/config', (req, res) => {
    db.get('SELECT * FROM chatbot_config ORDER BY id DESC LIMIT 1', (err, row) => {
        if (err) {
            logger.error(`Erro ao buscar configuração do chatbot: ${err.message}`);
            return res.status(500).json({ error: 'Erro interno do servidor' });
        }

        if (!row) {
            return res.status(404).json({ error: 'Configuração não encontrada' });
        }

        res.json({
            welcome_message: row.welcome_message,
            queue_selection_message: row.queue_selection_message,
            invalid_selection_message: row.invalid_selection_message,
            waiting_message: row.waiting_message,
            thank_you_message: row.thank_you_message,
            feedback_message: row.feedback_message
        });
    });
});

// POST /api/chatbot/config - Salvar configuração do chatbot
app.post('/api/chatbot/config', (req, res) => {
    const {
        welcome_message,
        queue_selection_message,
        invalid_selection_message,
        waiting_message,
        thank_you_message,
        feedback_message
    } = req.body;

    // Validação básica
    if (!welcome_message || !queue_selection_message || !invalid_selection_message || !waiting_message || !thank_you_message || !feedback_message) {
        return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
    }

    // Verifica se já existe uma configuração
    db.get('SELECT id FROM chatbot_config ORDER BY id DESC LIMIT 1', (err, existing) => {
        if (err) {
            logger.error(`Erro ao verificar configuração existente: ${err.message}`);
            return res.status(500).json({ error: 'Erro interno do servidor' });
        }

        const now = getLocalDateTime();

        if (existing) {
            // Atualiza configuração existente
            db.run(`UPDATE chatbot_config SET
                welcome_message = ?,
                queue_selection_message = ?,
                invalid_selection_message = ?,
                waiting_message = ?,
                thank_you_message = ?,
                feedback_message = ?,
                updated_at = ?
                WHERE id = ?`,
                [welcome_message, queue_selection_message, invalid_selection_message, waiting_message, thank_you_message, feedback_message, now, existing.id],
                function(updateErr) {
                    if (updateErr) {
                        logger.error(`Erro ao atualizar configuração do chatbot: ${updateErr.message}`);
                        return res.status(500).json({ error: 'Erro ao salvar configuração' });
                    }

                    logger.info('Configuração do chatbot atualizada com sucesso');
                    res.json({ message: 'Configuração salva com sucesso' });
                }
            );
        } else {
            // Insere nova configuração
            db.run(`INSERT INTO chatbot_config (
                welcome_message,
                queue_selection_message,
                invalid_selection_message,
                waiting_message,
                thank_you_message,
                feedback_message,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [welcome_message, queue_selection_message, invalid_selection_message, waiting_message, thank_you_message, feedback_message, now, now],
                function(insertErr) {
                    if (insertErr) {
                        logger.error(`Erro ao inserir configuração do chatbot: ${insertErr.message}`);
                        return res.status(500).json({ error: 'Erro ao salvar configuração' });
                    }

                    logger.info('Configuração do chatbot criada com sucesso');
                    res.json({ message: 'Configuração salva com sucesso' });
                }
            );
        }
    });
});

// Rota para servir a página do painel
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Servir arquivos estáticos (CSS, JS) do diretório atual
app.use(express.static(__dirname));

// Catch-all para rotas não encontradas (404)
app.use((req, res, next) => {
    res.status(404).json({ message: "Desculpe, o recurso que você procura não foi encontrado." });
});

// Socket.io connection handler
io.on('connection', (socket) => {
  logger.info(`Cliente conectado via WebSocket: ${socket.id}`);
  socket.on('disconnect', () => {
    logger.info(`Cliente desconectado do WebSocket: ${socket.id}`);
  });
});

server.listen(port, () => {
    logger.info(`Servidor rodando em http://localhost:${port}`);
    
    // Após o servidor iniciar, tenta reinicializar as conexões que estavam ativas
    // reinitializeActiveConnections(); // Desabilitado temporariamente - causando crash
});

// Tratamento específico para erros do servidor (ex: porta em uso) para evitar crash-loop
server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        logger.error(`Porta ${port} já está em uso. Verifique se não há outra instância rodando.`);
        // Não forçar exit imediato em ambientes de desenvolvimento; apenas logamos.
        // Se desejar encerrar, descomente a linha abaixo.
        // process.exit(1);
    } else {
        logger.error(`Erro no servidor HTTP: ${err && err.stack ? err.stack : err}`);
    }
});

// Tratamento de erros não capturados para evitar que o servidor pare
process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`);
    logger.error(error.stack);
});

// Rota de diagnóstico: enviar email de teste e retornar resultado SMTP
app.post('/api/test-email', async (req, res) => {
    const { to, subject, html } = req.body;
    if (!to) return res.status(400).json({ error: 'Campo "to" é obrigatório.' });

    const mailOptions = {
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'no-reply@localhost',
        to,
        subject: subject || 'PHTicket - Teste de envio',
        html: html || `<p>Teste de envio: ${new Date().toISOString()}</p>`
    };

    try {
        if (mailTransporter) {
            const info = await mailTransporter.sendMail(mailOptions);
            const preview = nodemailer.getTestMessageUrl ? nodemailer.getTestMessageUrl(info) : null;
            return res.json({ ok: true, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, preview });
        } else {
            const outDir = path.join(__dirname, 'logs', 'outgoing_emails');
            if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
            const fileName = `${Date.now()}-${to.replace(/[^a-z0-9@.]/gi, '_')}.html`;
            const filePath = path.join(outDir, fileName);
            const content = `To: ${to}\nSubject: ${subject}\n\n${html}`;
            fs.writeFileSync(filePath, content, { encoding: 'utf8' });
            return res.json({ ok: true, saved: filePath });
        }
    } catch (err) {
        logger.error('Erro ao enviar email de teste:', err);
        return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
    }
});

// Worker periódico para tentar reenviar mensagens que não foram entregues via WhatsApp
const PENDING_RETRY_INTERVAL_MS = 15 * 1000; // 15s
const MAX_RETRY_PER_MESSAGE = 6;
const pendingRetryCounts = {}; // { messageId: attempts }

async function attemptDeliverPendingMessages() {
    try {
    // Only attempt to resend messages that were created >5s ago to avoid race with in-flight sends
    // Exclui mensagens de arquivo (que começam com [Arquivo:) pois já foram enviadas como mídia
    db.all("SELECT id, ticket_id, body FROM messages WHERE sender = 'bot' AND (sent_via_whatsapp IS NULL OR sent_via_whatsapp = 0) AND body NOT LIKE '[Arquivo:%' AND datetime(timestamp) <= datetime('now','-5 seconds') ORDER BY timestamp ASC LIMIT 20", async (err, rows) => {
            if (err) return logger.warn('Erro ao buscar mensagens pendentes para reenvio:', err && err.message ? err.message : err);
            if (!rows || rows.length === 0) return; // nada a fazer

            for (const msg of rows) {
                try {
                    // checa contador de tentativas em memória
                    pendingRetryCounts[msg.id] = pendingRetryCounts[msg.id] || 0;
                    if (pendingRetryCounts[msg.id] >= MAX_RETRY_PER_MESSAGE) {
                        logger.warn(`Mensagem ${msg.id} excedeu número máximo de tentativas (${pendingRetryCounts[msg.id]}). Pulando.`);
                        continue;
                    }

                    // Buscar informações do ticket
                    db.get('SELECT contact_number, connection_id FROM tickets WHERE id = ?', [msg.ticket_id], async (tErr, ticket) => {
                        if (tErr || !ticket) {
                            logger.warn(`Não foi possível buscar ticket ${msg.ticket_id} ao tentar reenviar mensagem ${msg.id}`);
                            try {
                                // Marca a mensagem como inválida/sem ticket para evitar reenvios infinitos
                                db.run('UPDATE messages SET sent_via_whatsapp = -1 WHERE id = ?', [msg.id], (uErr) => {
                                    if (uErr) return logger.warn(`Falha ao marcar mensagem ${msg.id} como sem ticket: ${uErr.message}`);
                                    logger.info(`Mensagem ${msg.id} marcada como sem ticket (sent_via_whatsapp=-1) para evitar reenvios.`);
                                    try { io.emit('message_update', { id: msg.id, sent_via_whatsapp: -1, error: 'ticket_not_found' }); } catch (e) { /* ignore */ }
                                });
                            } catch (e) {
                                logger.warn(`Erro ao processar mensagem sem ticket ${msg.id}: ${e && e.message ? e.message : e}`);
                            }
                            // limpa qualquer contador de retry em memória
                            delete pendingRetryCounts[msg.id];
                            return;
                        }

                        // Seleciona conexão ativa existente (prefere connection_id do ticket)
                        let client = null;
                        let usedConnectionId = ticket.connection_id;
                        if (ticket.connection_id && sessions[String(ticket.connection_id)]) {
                            client = sessions[String(ticket.connection_id)];
                        } else {
                            const activeConnections = Object.keys(sessions).filter(sessionId => {
                                const s = sessions[sessionId];
                                return s && s.info && s.info.wid;
                            });
                            if (activeConnections.length > 0) {
                                usedConnectionId = activeConnections[0];
                                client = sessions[usedConnectionId];
                            }
                        }

                        if (!client) {
                            return logger.info(`Nenhuma sessão ativa encontrada para reenvio da mensagem ${msg.id} (ticket ${msg.ticket_id}).`);
                        }

                        const contactId = `${ticket.contact_number}@c.us`;
                        try {
                            const waMsg = await safeSendMessage(client, contactId, msg.body);
                            const waId = waMsg && waMsg.id && waMsg.id._serialized ? waMsg.id._serialized : null;
                            db.run('UPDATE messages SET sent_via_whatsapp = 1, wa_message_id = ? WHERE id = ?', [waId, msg.id], (uErr) => {
                                if (uErr) logger.warn(`Falha ao marcar mensagem ${msg.id} como enviada: ${uErr.message}`);
                                else {
                                    logger.info(`Mensagem pendente ${msg.id} reenviada com sucesso via conexão ${usedConnectionId}.`);
                                    // limpa contador
                                    delete pendingRetryCounts[msg.id];
                                    // Reseta contador de erros críticos em caso de sucesso
                                    if (sessionCriticalErrors[usedConnectionId]) {
                                        sessionCriticalErrors[usedConnectionId] = 0;
                                    }
                                    // Notifica frontends que a mensagem foi enviada
                                    try {
                                        io.emit('message_update', { id: msg.id, sent_via_whatsapp: 1, wa_message_id: waId });
                                    } catch (e) { logger.warn('Erro ao emitir message_update após reenvio worker:', e && e.message ? e.message : e); }
                                }
                            });
                        } catch (sendErr) {
                            // registra stack completo quando disponível
                            const errText = sendErr && sendErr.stack ? sendErr.stack : (sendErr && sendErr.message ? sendErr.message : String(sendErr));
                            pendingRetryCounts[msg.id] = (pendingRetryCounts[msg.id] || 0) + 1;
                            logger.warn(`Falha ao reenviar mensagem ${msg.id}: ${errText}`);

                            // Se o erro aparenta ser de sessão/puppeteer, incrementa contador
                            const low = (errText || '').toLowerCase();
                            if (low.includes('evaluation failed') || low.includes('session closed') || low.includes('target closed') || low.includes('protocol error')) {
                                sessionCriticalErrors[usedConnectionId] = (sessionCriticalErrors[usedConnectionId] || 0) + 1;
                                logger.warn(`Erro crítico na sessão ${usedConnectionId} ao reenviar msg ${msg.id} (${sessionCriticalErrors[usedConnectionId]}/${MAX_CRITICAL_ERRORS})`);
                                
                                if (sessionCriticalErrors[usedConnectionId] >= MAX_CRITICAL_ERRORS) {
                                    try {
                                        let shouldDestroy = true;
                                        try {
                                            const state = await client.getState();
                                            if (state === 'CONNECTED') {
                                                logger.info(`Sessão ${usedConnectionId} ainda CONNECTED, resetando contador.`);
                                                sessionCriticalErrors[usedConnectionId] = 0;
                                                shouldDestroy = false;
                                            }
                                        } catch (stateErr) { /* assume destruir */ }
                                        
                                        if (shouldDestroy) {
                                            logger.info(`Destruindo sessão ${usedConnectionId} após ${sessionCriticalErrors[usedConnectionId]} erros críticos.`);
                                            try { await client.destroy(); } catch (destroyErr) { logger.warn('Erro ao destruir client:', destroyErr && destroyErr.message ? destroyErr.message : destroyErr); }
                                            delete sessions[String(usedConnectionId)];
                                            delete sessionCriticalErrors[usedConnectionId];
                                            logger.info(`Sessão ${usedConnectionId} removida após erro.`);
                                        }
                                    } catch (cleanupErr) {
                                        logger.warn('Falha ao processar erro crítico:', cleanupErr && cleanupErr.message ? cleanupErr.message : cleanupErr);
                                    }
                                }
                            }
                        }
                    });
                } catch (e) {
                    logger.warn('Erro inesperado no reenvio de mensagens pendentes:', e && e.stack ? e.stack : e && e.message ? e.message : e);
                }
            }
        });
    } catch (e) {
        logger.warn('Erro no worker de reenvio:', e && e.stack ? e.stack : e && e.message ? e.message : e);
    }
}

// Inicia o worker com intervalo
setInterval(attemptDeliverPendingMessages, PENDING_RETRY_INTERVAL_MS);