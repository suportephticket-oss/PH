const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.db');
const id = process.argv[2] || 411;
const farewell = process.argv[3] || 'Mensagem de despedida teste';
const sentAt = new Date().toISOString().slice(0,19).replace('T',' ');

db.run('INSERT INTO messages (ticket_id, body, sender, timestamp) VALUES (?, ?, ?, ?)', [id, farewell, 'bot', sentAt], function(err) {
  if (err) {
    console.error('Erro ao inserir mensagem:', err.message);
    process.exit(1);
  }
  console.log('Inserido message id:', this.lastID);
  db.close();
});
