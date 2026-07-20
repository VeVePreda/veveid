import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Ouverture PARESSEUSE : un module ne doit pas faire d'entrée/sortie à
 * l'import (les imports ES sont hoistés, donc toute configuration posée
 * par l'appelant arriverait trop tard). Piège déjà payé deux fois.
 */
let _db: DatabaseSync | null = null;

export function base(): DatabaseSync {
  if (_db) return _db;
  const fichier = process.env.DB_PATH ?? './veve-id.db';
  try { mkdirSync(dirname(fichier), { recursive: true }); } catch { /* déjà là */ }
  _db = new DatabaseSync(fichier);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  _db.exec(SCHEMA);
  return _db;
}
export function fermer(): void { try { _db?.close(); } catch { /* déjà fermée */ } _db = null; }

/**
 * 🔴🔴 CE QUE CE SERVICE TIENT, ET CE QU'IL NE TIENT PAS.
 *
 *   IL TIENT   l'identité (compte ↔ portefeuille vérifié), LES AVOIRS
 *              (les collectibles réellement détenus), l'abonnement, et
 *              la suppression de compte.
 *
 *   ⛔ IL NE TIENT RIEN DU JEU. Ni héros, ni niveau, ni carte, ni codex.
 *      Le jour où l'on y mettrait « le niveau du héros », ce ne serait
 *      plus un service d'identité mais un second serveur de jeu — et il
 *      faudrait le migrer à chaque règle qui change.
 *      Les jeux gardent leurs données, indexées par `compte_id`.
 *
 * ⚠️ AUCUN BACKTICK dans ce gabarit : un backtick dans un commentaire SQL
 *    REFERME le template JavaScript, et l'erreur rendue parle de
 *    point-virgule. Piège payé deux fois le 20/07 sur Loop.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS comptes (
  id TEXT PRIMARY KEY,
  wallet TEXT UNIQUE NOT NULL,
  verifie INTEGER NOT NULL DEFAULT 0,
  verifie_le TEXT,
  cree_le TEXT NOT NULL,
  abonne_jusqu_a TEXT,
  -- Effacement demande : on garde la ligne le temps du delai de grace.
  supprime_le TEXT
);

CREATE TABLE IF NOT EXISTS defis (
  id TEXT PRIMARY KEY, wallet TEXT NOT NULL, compte_id TEXT,
  cibles TEXT NOT NULL, vus TEXT NOT NULL DEFAULT '[]',
  cree TEXT NOT NULL, expire TEXT NOT NULL, etat TEXT NOT NULL DEFAULT 'en_attente'
);
CREATE INDEX IF NOT EXISTS idx_defis_wallet ON defis(wallet, etat);

-- ⭐ LES AVOIRS : les collectibles reellement detenus, relus depuis la
--    chaine. C'est CE service qui les tient, une fois pour tous les jeux —
--    donc un seul quota consomme chez l'explorateur, et une seule verite.
CREATE TABLE IF NOT EXISTS avoirs (
  compte_id TEXT NOT NULL, mint_key TEXT NOT NULL,
  nom TEXT NOT NULL, edition INTEGER NOT NULL,
  rarete TEXT, image TEXT, vu_le TEXT NOT NULL,
  PRIMARY KEY (compte_id, mint_key)
);
CREATE INDEX IF NOT EXISTS idx_avoirs_compte ON avoirs(compte_id);

CREATE TABLE IF NOT EXISTS sync_log (
  compte_id TEXT PRIMARY KEY, dernier TEXT NOT NULL, resultat TEXT,
  -- Vue partielle : on ne retire RIEN dans ce cas. Voir avoirs.ts.
  complet INTEGER NOT NULL DEFAULT 1
);

-- Journal des connexions accordees a un jeu. Sert au support et a rien d'autre.
CREATE TABLE IF NOT EXISTS acces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compte_id TEXT NOT NULL, jeu TEXT NOT NULL, ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acces_compte ON acces(compte_id);

CREATE TABLE IF NOT EXISTS reglages (
  cle TEXT PRIMARY KEY, valeur TEXT NOT NULL, maj TEXT NOT NULL
);
`;

export const now = () => new Date().toISOString();
export const q = <T = any>(sql: string, ...p: any[]): T[] => base().prepare(sql).all(...p) as T[];
export const q1 = <T = any>(sql: string, ...p: any[]): T | undefined => base().prepare(sql).get(...p) as T | undefined;
export const run = (sql: string, ...p: any[]) => base().prepare(sql).run(...p);
