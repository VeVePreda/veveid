import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sousData, estUnMontage, controlerDemarrage, type Constat } from '../src/demarrage.ts';
import { expediteur, EXPEDITEUR_DEFAUT } from '../src/courriel.ts';

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
    'ID_SERVICE', 'JEUX', 'SESSION_SECRET', 'URL_PUBLIQUE', 'BREVO_CLE', 'COURRIEL_SIMULE',
    // ⚠️ AJOUTÉES AU LOT 97, ET L'OUBLI AURAIT ÉTÉ SILENCIEUX : une variable
    // absente de cette liste n'est pas effacée entre deux tests, donc le banc
    // lit l'environnement de la MACHINE. Il passerait chez moi et tomberait en
    // CI, ou l'inverse — et on chercherait dans le code.
    'BREVO_EXPEDITEUR', 'BREVO_NOM'];
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

/**
 * Un environnement complet et correct : le contrôle doit être MUET.
 *
 * ⭐⭐ CE QUE « COMPLET » VEUT DIRE A CHANGÉ AU LOT 89, et c'est pour ça
 *     que ces deux lignes sont ajoutées ICI plutôt qu'ailleurs.
 *
 * Trois bancs sont tombés en rouge le jour où l'inscription par courriel a
 * été ajoutée. La réparation tentante était de relâcher l'attente
 * (« ignorons les nouveaux constats ») — c'est précisément le geste qui
 * rend un banc muet. L'attente se LIT : une installation complète inclut
 * désormais de quoi envoyer un courriel, donc `BON` le dit.
 */
const BON = {
  EXIGER_VOLUME: '0',
  ID_PRIVEE: 'x', ID_PUBLIQUE: 'y', ID_SERVICE: 'z',
  JEUX: 'loop=https://loop.example.net',
  SESSION_SECRET: 'long',
  URL_PUBLIQUE: 'https://id.example.net', BREVO_CLE: 'xkeysib-essai',
  // ⭐ AJOUTÉE AU LOT 97, pour la même raison que `BREVO_CLE` au lot 89 : une
  // installation « complète » inclut désormais de quoi dire DEPUIS QUELLE
  // ADRESSE on écrit. Relâcher l'attente à la place aurait rendu muet le seul
  // constat qui parle quand tout va bien.
  BREVO_EXPEDITEUR: 'noreply@essai.example',
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


// ═════════════════════════════════════════════════════════════════════════
// L'inscription par courriel (lot 89)
// ═════════════════════════════════════════════════════════════════════════

/**
 * 🔴 CES DEUX MANQUES SONT INVISIBLES DEPUIS UN NAVIGATEUR. La page
 *    « vérifiez vos e-mails » est identique dans tous les cas — c'est
 *    voulu, elle ne doit pas dire si l'adresse existe. Conséquence :
 *    sans ces constats, une inscription qui n'envoie jamais rien
 *    ressemble EXACTEMENT à une inscription qui marche.
 */
test('URL_PUBLIQUE absente : GRAVE, et le message refuse le repli sur Host', () => {
  const d = mkdtempSync(join(tmpdir(), 'id-'));
  avec({ ...BON, URL_PUBLIQUE: undefined, DB_PATH: join(d, 'veve-id.db') }, () => {
    const c = controlerDemarrage();
    assert.equal(graves(c).length, 1);
    assert.equal(contient(c, 'URL_PUBLIQUE'), true);
    assert.equal(contient(c, 'Host'), true,
      'le message doit dire POURQUOI on ne se rabat pas sur l’en-tête Host');
  });
});

test('BREVO_CLE absente : GRAVE, et le message donne où la chercher', () => {
  const d = mkdtempSync(join(tmpdir(), 'id-'));
  avec({ ...BON, BREVO_CLE: undefined, DB_PATH: join(d, 'veve-id.db') }, () => {
    const c = controlerDemarrage();
    assert.equal(graves(c).length, 1);
    assert.equal(contient(c, 'xkeysib-'), true, 'le geste exact, pas seulement le constat');
    // 🔴🔴 CE BANC AFFIRMAIT LE CONTRAIRE JUSQU'AU LOT 97 : il exigeait que le
    // message nomme `mail.veveprice.com` comme domaine d'envoi. C'était FAUX —
    // ce sous-domaine est le Return-Path, pas un domaine authentifié. Un test
    // qui grave une erreur la rend impossible à corriger sans « casser » un
    // banc vert : c'est la forme la plus coûteuse de dette, parce qu'elle se
    // relit comme une garantie.
    assert.equal(contient(c, 'veveprice.com'), true,
      'l’expéditeur doit être sur un domaine authentifié : le dire ici évite un 400 Brevo');
    assert.equal(contient(c, "n'est PAS un domaine d'envoi"), true,
      'le message doit désamorcer le piège du Return-Path, sinon on le repose');
  });
});

test('COURRIEL_SIMULE=1 se signale, même sans clé — un repli muet n’en est pas un', () => {
  const d = mkdtempSync(join(tmpdir(), 'id-'));
  avec({ ...BON, BREVO_CLE: undefined, COURRIEL_SIMULE: '1', DB_PATH: join(d, 'veve-id.db') }, () => {
    const c = controlerDemarrage();
    assert.deepEqual(graves(c), [], 'la simulation est un choix explicite, pas une panne');
    assert.equal(contient(c, 'ECRITS DANS LE JOURNAL'), true,
      'un mode qui écrit des secrets dans les logs doit le DIRE');
  });
});


// ═════════════════════════════════════════════════════════════════════════
// L'EXPÉDITEUR (lot 97) — le contrôle qui parle même quand tout va bien
// ═════════════════════════════════════════════════════════════════════════

/**
 * ⭐⭐⭐ POURQUOI CES TROIS BANCS EXISTENT.
 *
 * Le 06/08, la question « depuis quelle adresse ce service envoie-t-il ? »
 * n'avait aucune réponse lisible : la variable vit dans Coolify, le défaut
 * vit dans le code, et le contrôle se taisait dès que la variable était
 * posée. Deux lots ont été dépensés à chercher des valeurs qu'aucune
 * requête ne pouvait lire.
 *
 * ⭐ Un contrôle qui ne parle que pour signaler un MANQUE laisse invisible
 *   la configuration EFFECTIVE. Ces bancs vérifient donc l'inverse de
 *   l'habitude : que le constat SORT quand tout est correct.
 */

test('l’expéditeur retenu est affiché même quand tout est correct', () => {
  const d = mkdtempSync(join(tmpdir(), 'id-'));
  avec({ ...BON, DB_PATH: join(d, 'veve-id.db') }, () => {
    const c = controlerDemarrage();
    assert.deepEqual(graves(c), []);
    assert.equal(contient(c, 'noreply@essai.example'), true,
      'l’adresse réellement utilisée doit être lisible dans le journal, pas seulement dans /sante');
    assert.equal(contient(c, 'BREVO_EXPEDITEUR'), true, 'et d’où elle vient');
  });
});

test('BREVO_EXPEDITEUR absente : attention, jamais grave — le service envoie quand même', () => {
  const d = mkdtempSync(join(tmpdir(), 'id-'));
  avec({ ...BON, BREVO_EXPEDITEUR: undefined, DB_PATH: join(d, 'veve-id.db') }, () => {
    const c = controlerDemarrage();
    assert.deepEqual(graves(c), [], 'le défaut est valide : ce n’est pas une panne, c’est un non-choix');
    assert.equal(contient(c, 'DEFAUT DU CODE'), true,
      'le journal doit dire que personne n’a choisi cette adresse pour CE déploiement');
  });
});

test('🔴 le défaut du code est noreply@veveprice.com, PAS le Return-Path', () => {
  // ⭐⭐ LE BANC QUI FERME LE PIÈGE. `mail.veveprice.com` est le sous-domaine
  // délégué à Brevo pour signer les rebonds ; ce n'est pas un domaine d'envoi.
  // Le défaut le nommait, donc tout redéploiement sans la variable aurait
  // envoyé depuis une adresse refusée par l'API — et la page aurait dit
  // « vérifiez vos e-mails » exactement comme un succès.
  // ⭐ On teste la CONSTANTE, pas la variable : c'est le défaut qui a menti,
  //   et c'est lui qui doit être surveillé.
  assert.equal(EXPEDITEUR_DEFAUT, 'noreply@veveprice.com');
  assert.equal(EXPEDITEUR_DEFAUT.includes('mail.veveprice.com'), false,
    'le Return-Path n’est pas un expéditeur — Brevo rend 400');
  const d = mkdtempSync(join(tmpdir(), 'id-'));
  avec({ ...BON, BREVO_EXPEDITEUR: undefined, DB_PATH: join(d, 'veve-id.db') }, () => {
    assert.equal(expediteur(), EXPEDITEUR_DEFAUT, 'sans variable, c’est la constante qui part');
    assert.equal(contient(controlerDemarrage(), 'noreply@veveprice.com'), true);
  });
});
