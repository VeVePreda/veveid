import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sousData, estUnMontage, controlerDemarrage, type Constat } from '../src/demarrage.ts';

/**
 * ⭐ CE QUE CES TESTS PROTÈGENT.
 *
 * Le contrôle de démarrage n'a qu'un seul rôle : PARLER quand l'installation
 * est fautive. Un contrôle qui se tait à tort est pire que pas de contrôle —
 * il donne une garantie fausse. Chaque test ci-dessous vérifie donc qu'une
 * faute PRÉCISE produit bien un constat grave.
 */

/** Pose un environnement propre, joue, et remet tout en place. */
function avec(env: Record<string, string | undefined>, f: () => void): void {
  const cles = ['DB_PATH', 'EXIGER_VOLUME', 'ID_PRIVEE', 'ID_PUBLIQUE',
    'ID_SERVICE', 'JEUX', 'SESSION_SECRET'];
  const avant = Object.fromEntries(cles.map((k) => [k, process.env[k]]));
  for (const k of cles) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try { f(); } finally {
    for (const k of cles) {
      if (avant[k] === undefined) delete process.env[k]; else process.env[k] = avant[k]!;
    }
  }
}

const graves = (c: Constat[]) => c.filter((x) => x.gravite === 'grave');
const contient = (c: Constat[], mot: string) =>
  c.some((x) => x.titre.includes(mot) || x.detail.includes(mot));

/** Un environnement complet et correct : le contrôle doit être MUET. */
const BON = {
  EXIGER_VOLUME: '0',
  ID_PRIVEE: 'x', ID_PUBLIQUE: 'y', ID_SERVICE: 'z',
  JEUX: 'loop=https://loop.example.net',
  SESSION_SECRET: 'long',
};

test('sousData compare des SEGMENTS, pas des caractères', () => {
  // Le cœur du piège : `/database` commence bien par `/data`.
  assert.equal(sousData('/data'), true);
  assert.equal(sousData('/data/veve-id.db'), true);
  assert.equal(sousData('/database/veve-id.db'), false);
  assert.equal(sousData('/data-essai/veve-id.db'), false);
  assert.equal(sousData('/tmp/veve-id.db'), false);
});

test('estUnMontage reconnaît la racine et ignore ce qui n’est pas monté', () => {
  let mountinfo = true;
  try { estUnMontage('/'); } catch { mountinfo = false; }
  if (!mountinfo) return;
  // `/` figure toujours dans mountinfo sous Linux ; un dossier inventé, jamais.
  assert.equal(estUnMontage('/'), true);
  assert.equal(estUnMontage('/ce-dossier-nexiste-pas-du-tout'), false);
});

test('installation complète et correcte : aucun problème grave', () => {
  const d = mkdtempSync(join(tmpdir(), 'id-'));
  avec({ ...BON, DB_PATH: join(d, 'veve-id.db') }, () => {
    const c = controlerDemarrage();
    assert.deepEqual(graves(c), [], 'un environnement correct ne doit rien signaler');
    assert.equal(c[0].gravite, 'ok');
  });
});

test('dossier inscriptible mais SANS volume : GRAVE, et le message dit quoi faire', () => {
  // ⚠️ Première version de ce test : `DB_PATH=/data/veve-id.db`. Elle tombait,
  // et pour une raison instructive — hors conteneur, `/data` n'est pas
  // seulement « non monté », il est INACCESSIBLE EN ÉCRITURE. C'était donc
  // l'autre constat grave qui sortait, et le test mesurait l'environnement au
  // lieu de mesurer le code.
  // On isole donc le seul cas qui nous intéresse : un dossier parfaitement
  // inscriptible qui n'est simplement pas un point de montage — exactement la
  // situation d'un `/data` créé par le Dockerfile mais jamais monté par
  // Coolify. C'est LA panne silencieuse que ce fichier existe pour attraper.
  const d = mkdtempSync(join(tmpdir(), 'id-'));
  assert.equal(estUnMontage(d), false, 'un dossier temporaire n’est pas un montage');
  avec({ ...BON, DB_PATH: join(d, 'veve-id.db'), EXIGER_VOLUME: '1' }, () => {
    const c = controlerDemarrage();
    assert.equal(graves(c).length, 1);
    assert.equal(contient(c, 'IDENTITÉS SERONT PERDUES'), true);
    assert.equal(contient(c, 'Destination Path'), true,
      'le message doit donner le geste exact dans Coolify, pas seulement le constat');
  });
});

test('clés absentes : GRAVE — le joueur prouverait sa propriété pour rien', () => {
  const d = mkdtempSync(join(tmpdir(), 'id-'));
  avec({ ...BON, ID_PRIVEE: undefined, DB_PATH: join(d, 'veve-id.db') }, () => {
    assert.equal(contient(controlerDemarrage(), 'AUCUN JETON'), true);
  });
});

test('JEUX vide : GRAVE — la liste blanche vide ferme la porte à tous', () => {
  const d = mkdtempSync(join(tmpdir(), 'id-'));
  avec({ ...BON, JEUX: undefined, DB_PATH: join(d, 'veve-id.db') }, () => {
    assert.equal(contient(controlerDemarrage(), 'JEUX est vide'), true);
  });
});

test('ID_SERVICE et SESSION_SECRET absents : attention, jamais grave', () => {
  const d = mkdtempSync(join(tmpdir(), 'id-'));
  avec({ ...BON, ID_SERVICE: undefined, SESSION_SECRET: undefined, DB_PATH: join(d, 'veve-id.db') }, () => {
    const c = controlerDemarrage();
    assert.deepEqual(graves(c), [], 'ces deux-là gênent, ils n’empêchent pas de servir');
    assert.equal(c.filter((x) => x.gravite === 'attention').length, 2);
  });
});
