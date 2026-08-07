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
  /**
   * ⚠️ APRÈS le schéma, et TOUJOURS — base neuve comprise. `migrer()` est
   *    idempotente : sur une base déjà à la bonne forme elle ne fait rien
   *    et rend un journal vide. C'est ce qui permet de ne pas avoir à
   *    savoir, au démarrage, laquelle des deux situations on est.
   */
  for (const ligne of migrer(_db)) console.log(`[base] migration : ${ligne}`);
  return _db;
}
export function fermer(): void { try { _db?.close(); } catch { /* déjà fermée */ } _db = null; }

/**
 * 🔴🔴 CE QUE CE SERVICE TIENT, ET CE QU'IL NE TIENT PAS.
 *
 *   IL TIENT   l'identité (compte ↔ e-mail, et compte ↔ portefeuille
 *              vérifié quand il y en a un), LES AVOIRS (les collectibles
 *              réellement détenus), l'abonnement, et la suppression.
 *
 *   ⛔ IL NE TIENT RIEN DU JEU. Ni héros, ni niveau, ni carte, ni codex.
 *      Le jour où l'on y mettrait « le niveau du héros », ce ne serait
 *      plus un service d'identité mais un second serveur de jeu — et il
 *      faudrait le migrer à chaque règle qui change.
 *      Les jeux gardent leurs données, indexées par `compte_id`.
 *
 * ⛔ IL NE TIENT AUCUN MOT DE PASSE, et c'est définitif. Un mot de passe
 *    est une chose qu'on se fait voler ; un lien à usage unique envoyé par
 *    courriel n'existe que quinze minutes et ne se réutilise pas. Il n'y a
 *    donc rien à hacher, rien à faire tourner, rien à perdre.
 *
 * ⚠️ AUCUN BACKTICK dans ce gabarit : un backtick dans un commentaire SQL
 *    REFERME le template JavaScript, et l'erreur rendue parle de
 *    point-virgule. Piège payé deux fois le 20/07 sur Loop.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS comptes (
  id TEXT PRIMARY KEY,
  -- 🔴 wallet NULLABLE depuis le lot 89 : la porte d'entree est desormais
  --    l'e-mail, et la majorite des visiteurs n'ont PAS de portefeuille
  --    VeVe. L'unicite est portee par un index PARTIEL (voir migrer()),
  --    pas par une contrainte de colonne : plusieurs comptes sans
  --    portefeuille doivent coexister.
  wallet TEXT,
  email TEXT,
  verifie INTEGER NOT NULL DEFAULT 0,
  verifie_le TEXT,
  cree_le TEXT NOT NULL,
  abonne_jusqu_a TEXT,
  -- Effacement demande : on garde la ligne le temps du delai de grace.
  supprime_le TEXT
);

-- ═══════════════════════════════════════════════════════════════════════
-- LE RELAIS (lot 99) : entrer ICI depuis une session ouverte sur un SITE.
-- ═══════════════════════════════════════════════════════════════════════
-- ⭐⭐ LE PARCOURS DE PREUVE DE PROPRIETE VIT SUR CE SERVICE, PAS SUR LES
--    SITES. Il lit la chaine, il tient les defis, il connait les avoirs.
--    Le recopier dans veveprice serait l'ecrire une troisieme fois apres
--    Loop et MightysArena -- c'est exactement ce que le deplacement du
--    20/07 a voulu arreter.
-- ⭐ Un membre connecte sur veveprice doit donc pouvoir ARRIVER ici sans
--    redemander un lien par courriel. C'est le seul objet de cette table.
--
-- 🔴 MEME FORME QUE "codes", ET POUR LA MEME RAISON : ce qui voyage dans
--    une URL doit etre a USAGE UNIQUE et vivre une minute. La difference
--    tient en un mot -- "codes" ouvre une session sur le SITE, "relais"
--    ouvre une session ICI. Deux portes, deux jetons : un seul jeton qui
--    ouvrirait les deux serait une elevation de privilege deguisee en
--    economie de code.
CREATE TABLE IF NOT EXISTS relais (
  empreinte TEXT PRIMARY KEY,
  compte_id TEXT NOT NULL,
  vers TEXT NOT NULL,
  cree TEXT NOT NULL,
  expire TEXT NOT NULL,
  consomme_le TEXT
);

CREATE TABLE IF NOT EXISTS defis (
  id TEXT PRIMARY KEY, wallet TEXT NOT NULL, compte_id TEXT,
  cibles TEXT NOT NULL, vus TEXT NOT NULL DEFAULT '[]',
  cree TEXT NOT NULL, expire TEXT NOT NULL, etat TEXT NOT NULL DEFAULT 'en_attente'
);
CREATE INDEX IF NOT EXISTS idx_defis_wallet ON defis(wallet, etat);

-- 🔥 LOT 106 — LA DÉCOUVERTE DE PORTEFEUILLE, SANS ADRESSE.
-- ⚠️ TABLE À PART, ET C'EST DÉLIBÉRÉ. La table defis est indexée PAR
--    PORTEFEUILLE et sa colonne wallet est NOT NULL : c'est sa nature, elle
--    part d'une adresse connue. Ici l'adresse est le RÉSULTAT, pas l'entrée.
--    Forcer les deux dans la même table demanderait de rendre wallet
--    nullable, donc d'affaiblir la seule contrainte qui protège l'ancien
--    parcours.
--    ⭐ Deux protocoles qui partent de données différentes ne partagent pas
--    leur table : ils partagent lier(), qui est le seul geste commun.
-- ⚠️ paires = ce que la personne a DÉCLARÉ, scellé dès la création.
--    vues   = ce que la chaîne a rendu : clé -> from, at, comic.
-- 🔴 AUCUN ACCENT GRAVE DANS CE FICHIER : ce schéma est un littéral de
--    gabarit, un accent grave le referme et le reste du schéma devient du
--    code. Payé à l'écriture de ce lot même.
CREATE TABLE IF NOT EXISTS decouvertes (
  id TEXT PRIMARY KEY, compte_id TEXT NOT NULL,
  paires TEXT NOT NULL, vues TEXT NOT NULL DEFAULT '{}',
  wallet TEXT, cree TEXT NOT NULL, expire TEXT NOT NULL,
  etat TEXT NOT NULL DEFAULT 'en_attente'
);
CREATE INDEX IF NOT EXISTS idx_decouvertes_compte ON decouvertes(compte_id, etat);

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

-- ⭐⭐ LES LIENS DE CONNEXION (lot 89).
--
-- 🔴 ON N'ENREGISTRE PAS LE JETON, ON ENREGISTRE SON EMPREINTE. Le jeton
--    n'existe en clair qu'une fois : dans le courriel. Une copie de cette
--    base — sauvegarde egaree, disque revendu, acces en lecture — ne
--    donne donc AUCUN lien utilisable. Le meme raisonnement que pour un
--    mot de passe, applique a un secret qui vit quinze minutes.
--
-- ⚠️ consomme_le n'est pas un confort : c'est ce qui rend le lien a
--    usage UNIQUE. Un lien reste dans une boite mail, dans un historique,
--    dans le journal d'un antivirus qui pre-visite les liens.
CREATE TABLE IF NOT EXISTS liens (
  empreinte TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  cree TEXT NOT NULL,
  expire TEXT NOT NULL,
  consomme_le TEXT,
  -- ⭐ Lot 90 : ou renvoyer la personne apres le clic. Vide = elle reste
  --    ici. Renseigne = elle repart sur le site qui l'a inscrite, et ce
  --    site pose SA session. ⛔ Verifie par retourAutorise() AVANT d'etre
  --    ecrit, jamais au moment de la redirection : une adresse controlee
  --    a l'entree ne peut plus devenir mauvaise en sortie.
  retour TEXT
);
CREATE INDEX IF NOT EXISTS idx_liens_email ON liens(email, cree);

-- ⭐⭐ LES SESSIONS DES SITES (lot 90) — voir sessions.ts pour le pourquoi.
--
-- 🔴 ON N'ENREGISTRE QUE L'EMPREINTE DU sid, comme pour les liens. Le sid
--    vit dans un cookie chez la personne ; la base n'en garde que la
--    trace. Une copie de la base n'ouvre donc aucune session.
--
-- ⛔ LE PALIER N'EST PAS STOCKE ICI. Il se recalcule a chaque lecture
--    depuis abonne_jusqu_a. Le figer ferait qu'un abonnement expire
--    continuerait d'ouvrir jusqu'a la fin de la session — trente jours.
CREATE TABLE IF NOT EXISTS sessions (
  empreinte TEXT PRIMARY KEY,
  compte_id TEXT NOT NULL,
  cree TEXT NOT NULL,
  expire TEXT NOT NULL,
  vue_le TEXT,
  revoquee_le TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_compte ON sessions(compte_id);

-- Le code d'echange : la seule chose qui voyage dans une URL, et elle ne
-- vit que soixante secondes. Voir DUREE_CODE_S dans sessions.ts.
CREATE TABLE IF NOT EXISTS codes (
  empreinte TEXT PRIMARY KEY,
  compte_id TEXT NOT NULL,
  cree TEXT NOT NULL,
  expire TEXT NOT NULL,
  consomme_le TEXT
);
`;

/**
 * ⭐⭐ LA MIGRATION — et pourquoi elle ne peut pas être un simple ALTER.
 *
 * SQLite ne sait pas retirer un `NOT NULL` ni une contrainte `UNIQUE` de
 * colonne. La seule voie est la recopie : table neuve à la bonne forme,
 * copie des lignes, échange des noms. C'est la procédure officielle, et
 * elle est SÛRE tant qu'elle est faite dans une transaction.
 *
 * 🔴 CE QUI REND CETTE MIGRATION PARTICULIÈRE : la table `comptes` porte
 *    la liaison compte ↔ portefeuille, et cette liaison a COÛTÉ au
 *    détenteur (deux collectibles mis en vente, attendus, annulés). On ne
 *    la reconstruit pas, on la recopie — et on refuse d'avancer si le
 *    compte des lignes ne correspond pas.
 *
 * ⭐ POURQUOI UN INDEX UNIQUE **PARTIEL**. En SQLite, plusieurs NULL sont
 *    déjà considérés comme distincts dans un index unique : `wallet TEXT
 *    UNIQUE` nullable aurait suffi. On écrit quand même
 *    `WHERE wallet IS NOT NULL` parce que la règle qu'on veut est « deux
 *    comptes ne partagent pas un portefeuille », pas « le moteur veut
 *    bien ». Une intention écrite se relit ; un effet de bord se
 *    redécouvre.
 *
 * ⚠️ `PRAGMA foreign_keys` ne change pas de valeur à l'intérieur d'une
 *    transaction — silencieusement. On le pose donc AVANT le BEGIN.
 */
export function migrer(db: DatabaseSync): string[] {
  const journal: string[] = [];
  const colonnes = db.prepare('PRAGMA table_info(comptes)').all() as Array<{ name: string; notnull: number }>;
  if (!colonnes.length) return journal;                    // pas de table : rien à faire
  const a = (nom: string) => colonnes.some((c) => c.name === nom);
  const walletObligatoire = colonnes.some((c) => c.name === 'wallet' && c.notnull === 1);

  if (walletObligatoire) {
    const avant = (db.prepare('SELECT COUNT(*) AS n FROM comptes').get() as { n: number }).n;
    // Les colonnes à recopier : celles que l'ANCIENNE table possède ET que
    // la nouvelle possède. Écrire la liste en dur ferait échouer la
    // migration le jour où une colonne aura été ajoutée entre-temps.
    const cibles = ['id', 'wallet', 'email', 'verifie', 'verifie_le', 'cree_le', 'abonne_jusqu_a', 'supprime_le'];
    const communes = cibles.filter((c) => a(c));
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec(`
BEGIN IMMEDIATE;
CREATE TABLE comptes_nouveau (
  id TEXT PRIMARY KEY,
  wallet TEXT,
  email TEXT,
  verifie INTEGER NOT NULL DEFAULT 0,
  verifie_le TEXT,
  cree_le TEXT NOT NULL,
  abonne_jusqu_a TEXT,
  supprime_le TEXT
);
INSERT INTO comptes_nouveau (${communes.join(', ')})
  SELECT ${communes.join(', ')} FROM comptes;
DROP TABLE comptes;
ALTER TABLE comptes_nouveau RENAME TO comptes;
COMMIT;`);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* rien à annuler */ }
      db.exec('PRAGMA foreign_keys = ON');
      throw e;
    }
    db.exec('PRAGMA foreign_keys = ON');
    const apres = (db.prepare('SELECT COUNT(*) AS n FROM comptes').get() as { n: number }).n;
    /**
     * 🔴 UN CONTRÔLE QUI N'A RIEN INSPECTÉ N'A RIEN PROUVÉ. On compare
     *    les DEUX comptages. Sur une base vide, avant et après valent zéro
     *    et le contrôle est effectivement muet — c'est pour ça que la
     *    ligne suivante DIT combien de lignes ont voyagé, au lieu de se
     *    contenter d'un « ✅ ».
     */
    if (apres !== avant) throw new Error(`migration comptes : ${avant} ligne(s) avant, ${apres} après — la base n'a PAS été échangée`);
    journal.push(`table comptes recréée, wallet devient facultatif (${avant} ligne(s) recopiée(s), ${avant === 0 ? 'base vide' : 'toutes retrouvées'})`);
  } else if (!a('email')) {
    db.exec('ALTER TABLE comptes ADD COLUMN email TEXT');
    journal.push('colonne email ajoutée');
  }

  /**
   * ⭐ Lot 90, sur une base déjà passée au lot 89 : la table `liens` existe
   *    sans sa colonne `retour`. `CREATE TABLE IF NOT EXISTS` ne la voit
   *    pas — c'est exactement le piège de la migration silencieuse, sauf
   *    qu'ici l'échec serait bruyant (colonne inconnue au premier envoi).
   *    On l'ajoute donc explicitement.
   */
  const liens = db.prepare('PRAGMA table_info(liens)').all() as Array<{ name: string }>;
  if (liens.length && !liens.some((c) => c.name === 'retour')) {
    db.exec('ALTER TABLE liens ADD COLUMN retour TEXT');
    journal.push('colonne retour ajoutée aux liens');
  }

  const dejaLa = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((x) => x.name));
  if (!dejaLa.has('idx_comptes_wallet')) {
    db.exec('CREATE UNIQUE INDEX idx_comptes_wallet ON comptes(wallet) WHERE wallet IS NOT NULL');
    journal.push('index unique partiel sur wallet');
  }
  if (!dejaLa.has('idx_comptes_email')) {
    db.exec('CREATE UNIQUE INDEX idx_comptes_email ON comptes(email) WHERE email IS NOT NULL');
    journal.push('index unique partiel sur email');
  }
  return journal;
}

export const now = () => new Date().toISOString();
export const q = <T = any>(sql: string, ...p: any[]): T[] => base().prepare(sql).all(...p) as T[];
export const q1 = <T = any>(sql: string, ...p: any[]): T | undefined => base().prepare(sql).get(...p) as T | undefined;
export const run = (sql: string, ...p: any[]) => base().prepare(sql).run(...p);
