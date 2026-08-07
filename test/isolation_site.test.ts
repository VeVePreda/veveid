import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 🔥 LOT 107 — LA MIGRATION D'UNE BASE **DÉJÀ EN PRODUCTION**.
 *
 * ⭐⭐⭐ CE BANC EXISTE PARCE QUE L'AUTRE NE VOYAIT PAS LE CAS QUI COMPTE.
 * En désarmant le `DROP INDEX` des anciens index globaux, tous les bancs
 * restaient VERTS : sur une base NEUVE, ces index n'ont jamais existé, il n'y
 * a rien à retirer. Or la base de production, elle, les PORTE.
 * ⇒ Les laisser en place tiendrait l'ANCIENNE règle en plus de la nouvelle :
 *   « un portefeuille = un compte » pour tout le service, alors que le code
 *   dit partout « par site ». La règle neuve serait écrite, aurait l'air
 *   appliquée, et l'ancienne gagnerait. En silence.
 * ⭐ « Est-ce écrit ? » et « est-ce ce qui gagne ? » — la même question qu'en
 *   CSS, transposée à un index SQL.
 *
 * ⛔ Ce banc part donc d'une base à la forme EXACTE de la production : colonnes
 *    du lot 89/90 + les deux index uniques GLOBAUX.
 */

const dossier = mkdtempSync(join(tmpdir(), 'veveid-107-'));
after(() => rmSync(dossier, { recursive: true, force: true }));

const W1 = '0x' + '1'.repeat(40);
const W2 = '0x' + '2'.repeat(40);

function baseDeProduction(nom: string): string {
  const f = join(dossier, nom);
  const db = new DatabaseSync(f);
  db.exec(`CREATE TABLE comptes (
    id TEXT PRIMARY KEY, wallet TEXT, email TEXT, verifie INTEGER NOT NULL DEFAULT 0,
    verifie_le TEXT, cree_le TEXT NOT NULL, abonne_jusqu_a TEXT, supprime_le TEXT);
  CREATE UNIQUE INDEX idx_comptes_wallet ON comptes(wallet) WHERE wallet IS NOT NULL;
  CREATE UNIQUE INDEX idx_comptes_email ON comptes(email) WHERE email IS NOT NULL;`);
  const ins = db.prepare('INSERT INTO comptes (id, wallet, email, verifie, verifie_le, cree_le) VALUES (?,?,?,?,?,?)');
  ins.run('juillet', W1, 'preda@exemple.net', 1, '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z');
  ins.run('aout', null, 'preda2@exemple.net', 0, null, '2026-08-07T00:00:00.000Z');
  db.close();
  return f;
}

test('🔴 une base de PRODUCTION migre : les lignes restent, les index globaux partent', async () => {
  const f = baseDeProduction('prod.db');
  process.env.DB_PATH = f;
  process.env.SITE_DEFAUT = 'veveprice';
  const m = await import('../src/db.ts');
  const base = m.base();

  // ── 0. L'INSTRUMENT AVANT LA MESURE : la base de départ portait bien
  //      l'ancienne forme, sinon ce banc ne prouverait rien.
  const lignes = base.prepare('SELECT COUNT(*) AS n FROM comptes').get() as { n: number };
  assert.equal(lignes.n, 2, 'les deux comptes doivent avoir traversé la migration');

  // ── 1. La colonne existe, et AUCUNE ligne n'est sans site.
  const sansSite = base.prepare("SELECT COUNT(*) AS n FROM comptes WHERE site IS NULL OR site=''").get() as { n: number };
  assert.equal(sansSite.n, 0);
  const juillet = base.prepare('SELECT * FROM comptes WHERE id=?').get('juillet') as any;
  assert.equal(juillet.site, 'veveprice', 'les comptes existants rejoignent le seul site à espace membre');
  assert.equal(juillet.wallet, W1, 'la liaison a COÛTÉ deux mises en vente : on la recopie, on ne la refait pas');
  assert.equal(juillet.verifie, 1);

  // ── 2. 🔴 LES ANCIENS INDEX GLOBAUX ONT DISPARU.
  const index = (base.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>)
    .map((x) => x.name);
  assert.ok(!index.includes('idx_comptes_wallet'), 'l\'ancien index global sur wallet doit être retiré');
  assert.ok(!index.includes('idx_comptes_email'), 'l\'ancien index global sur email doit être retiré');
  assert.ok(index.includes('idx_comptes_site_wallet'));
  assert.ok(index.includes('idx_comptes_site_email'));

  // ── 3. ⭐ LA PREUVE PAR L'ÉCRITURE, pas par le nom de l'index : le même
  //      portefeuille ET la même adresse doivent pouvoir exister sur un
  //      SECOND site. C'est ce qu'un index global aurait refusé.
  base.prepare('INSERT INTO comptes (id, site, wallet, email, verifie, cree_le) VALUES (?,?,?,?,?,?)')
    .run('ailleurs', 'vevewiki', W1, 'preda@exemple.net', 1, '2026-08-07T00:00:00.000Z');
  const combien = base.prepare('SELECT COUNT(*) AS n FROM comptes WHERE wallet=?').get(W1) as { n: number };
  assert.equal(combien.n, 2, 'le même portefeuille vit sur deux sites — c\'est tout l\'objet du lot');

  // ── 4. ⛔ ET SUR UN MÊME SITE, C'EST TOUJOURS REFUSÉ.
  assert.throws(() => {
    base.prepare('INSERT INTO comptes (id, site, wallet, cree_le) VALUES (?,?,?,?)')
      .run('doublon', 'veveprice', W1, '2026-08-07T00:00:00.000Z');
  }, /UNIQUE|constraint/i, 'deux comptes du MÊME site ne partagent pas un portefeuille');

  m.fermer();
});

test('la migration est un non-événement la seconde fois', async () => {
  const f = baseDeProduction('prod2.db');
  const db = new DatabaseSync(f);
  const m = await import('../src/db.ts');
  assert.ok(m.migrer(db).length > 0, 'le premier passage fait quelque chose');
  assert.deepEqual(m.migrer(db), [], 'le second ne doit rien faire');
  db.close();
});
