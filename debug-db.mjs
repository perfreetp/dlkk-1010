import { initDatabase, db } from './src/db/init.js';
import { get, all, forceSave } from './src/db/connection.js';

(async () => {
  await initDatabase();
  const rooms = await all('SELECT COUNT(*) as c FROM rooms');
  const fees = await all('SELECT COUNT(*) as c FROM fees');
  const join = await all(`SELECT COUNT(*) as c FROM fees f JOIN rooms r ON f.room_id = r.id`);
  console.log('rooms:', rooms[0].c, 'fees:', fees[0].c, 'join:', join[0].c);
  const statuses = await all('SELECT status, COUNT(*) as c FROM fees GROUP BY status');
  console.log('status dist:', statuses);
  const sample = await all('SELECT f.id, f.room_id, r.id as rid, f.room_number, f.status FROM fees f JOIN rooms r ON f.room_id = r.id LIMIT 3');
  console.log('join sample:', sample);
  const nojoin = await all('SELECT f.id, f.room_id, f.room_number FROM fees f LIMIT 3');
  console.log('fees sample:', nojoin);
  const roomsSample = await all('SELECT id, room_number FROM rooms LIMIT 3');
  console.log('rooms sample:', roomsSample);
  process.exit(0);
})();
