# PHTicket

Aplicação de atendimento via WhatsApp Web com painel em Bootstrap, Socket.IO e SQLite.

## Requisitos
- Node.js 18+
- Windows com Google Chrome opcional (o whatsapp-web.js usa Chromium embutido por padrão)

## Instalação
1. Instalar dependências
2. Iniciar o servidor

```powershell
npm install
npm run dev # desenvolvimento com nodemon
# ou
npm start   # produção simples
```

Acesse: http://localhost:5500

## Estrutura
- `server.js`: API Express, Socket.IO, integração WhatsApp Web, banco SQLite.
- `dashboard.html` / `dashboard.js`: Painel de gestão.
- `index.html` / `script.js`: Tela de login/registro.
- `style.css`: Estilos.
- `logs/`: Arquivos de log do servidor (Winston).
- `database.db`: Banco local SQLite (criado automaticamente).

## Observações
- As tabelas do banco são criadas automaticamente ao iniciar.
- Para conectar o WhatsApp, crie uma conexão em "Conexões" e escaneie o QR.
- Se algum erro de permissão ou puppeteer ocorrer, reinicie e tente novamente.
