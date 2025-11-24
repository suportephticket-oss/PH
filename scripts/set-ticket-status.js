const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const idArg = process.argv[2];
const statusArg = process.argv[3];
if (!idArg || !statusArg) {
  console.error('Uso: node scripts/set-ticket-status.js <ticket_id> <status>');
  process.exit(2);
}
const ticketId = parseInt(idArg, 10);
if (isNaN(ticketId)) {
  console.error('ticket_id inválido');
  process.exit(2);
}
const allowed = ['pending','attending','waiting','resolved','deleted'];
if (!allowed.includes(statusArg)) {
  console.error('status inválido. Valores permitidos:', allowed.join(', '));
  process.exit(2);
}

const dbPath = path.join(__dirname, '..', 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Erro ao conectar ao DB:', err.message);
    process.exit(1);
  }
});

db.serialize(() => {
  const updateSql = 'UPDATE tickets SET status = ? WHERE id = ?';
  db.run(updateSql, [statusArg, ticketId], function(err) {
    if (err) {
      console.error('Erro no UPDATE:', err.message);
      db.close();
      process.exit(1);
    }
    console.log(`Linhas afetadas: ${this.changes}`);
    db.get('SELECT id,contact_name,contact_number,status,user_id,is_on_hold,queue_id,last_message_at,protocol_number FROM tickets WHERE id = ?', [ticketId], (err, row) => {
      if (err) {
        console.error('Erro ao selecionar ticket atualizado:', err.message);
        db.close();
        process.exit(1);
      }
      if (!row) {
        console.log('Ticket não encontrado após UPDATE.');
      } else {
        console.log('Ticket atualizado:');
        console.log(JSON.stringify(row, null, 2));
      }
      db.close();
    });
  });
});
