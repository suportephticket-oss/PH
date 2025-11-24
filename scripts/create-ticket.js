const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.db');
const now = new Date().toISOString().slice(0,19).replace('T',' ');
const sql = `INSERT INTO tickets (contact_name, contact_number, profile_pic_url, last_message, status, unread_messages, last_message_at, connection_id, queue_id, user_id, is_on_hold) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, 1)`;
db.run(sql, ['Contato Teste', '5531999999999', null, 'Ticket de teste', now], function(err) {
  if (err) {
    console.error('Erro ao criar ticket:', err.message);
    process.exit(1);
  }
  console.log('Ticket criado com id:', this.lastID);
  db.close();
});
