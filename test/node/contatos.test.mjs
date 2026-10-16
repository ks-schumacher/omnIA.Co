// Administrator contacts page: CSV parsing and the Excel-friendly export.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, excelCsv, localDate } from '../../src/app/contatos.js';

test('parses the /api/leads CSV, including quoted fields', () => {
  const csv = 'email,verified,firstSeen,lastSeen,verifiedAt,requests,lang\n' +
    'a@b.com,true,2026-10-16T12:00:00.000Z,2026-10-16T12:05:00.000Z,2026-10-16T12:05:00.000Z,2,pt\n' +
    '"x,y@z.org",false,2026-10-16T13:00:00.000Z,,,1,en\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['a@b.com', 'true', '2026-10-16T12:00:00.000Z', '2026-10-16T12:05:00.000Z', '2026-10-16T12:05:00.000Z', '2', 'pt']);
  assert.equal(rows[2][0], 'x,y@z.org');
  assert.equal(rows[2][4], '');
  assert.deepEqual(parseCsv('a,"he said ""hi"""\r\n'), [['a', 'he said "hi"']]);
});

test('Excel export: BOM, semicolons, CRLF, quoting', () => {
  const out = excelCsv(['E-mail', 'Nota'], [['a@b.com', 'ok'], ['c@d.com', 'tem; ponto e vírgula']]);
  assert.ok(out.startsWith('﻿'));
  assert.equal(out, '﻿E-mail;Nota\r\na@b.com;ok\r\nc@d.com;"tem; ponto e vírgula"\r\n');
});

test('dates are shown as dd/mm/aaaa hh:mm in local time', () => {
  assert.match(localDate('2026-10-16T12:05:00.000Z'), /^\d{2}\/\d{2}\/2026 \d{2}:\d{2}$/);
  assert.equal(localDate(''), '');
});
