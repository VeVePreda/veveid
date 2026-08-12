// ⚠️ DEPOT : VeVePreda/veveid   ·   CHEMIN : test/service.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

/**
 * 🔴🔴 LOT 141 — L'API DE SERVICE, ENFIN RÉCLAMÉE PAR QUELQU'UN.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER EXISTE : UN CIRCUIT OUVERT
 * ═══════════════════════════════════════════════════════════════════════
 * Le 12/08/2026, un `grep` sur `test/` rendait **zéro** occurrence de
 * `/api/avoirs`, de `x-service` et de `/api/session`. La route la plus
 * sensible de ce service — celle qui rend les données d'un compte contre
 * un secret partagé — n'était réclamée par personne. Un contrôle qui ne
 * regarde que ce qui existe ne voit jamais ce qui manque : ici, il ne
 * manquait pas un contrôle, il manquait le RÉCLAMANT.
 *
 * ⭐⭐⭐ ET CE QUE CE BANC GARDE AVANT TOUT, C'EST UN PRINCIPE, PAS UNE
 *    FONCTION : **LE SITE NE DÉSIGNE JAMAIS UN COMPTE.**
 *
 * `/api/avoirs` s'identifiait par `?compte=<identifiant>`. veveprice, lui,
 * ne détient pas d'identifiant de compte : il a un `sid`, et rien d'autre.
 * Lui faire porter l'identifiant reviendrait à le laisser DÉSIGNER un
 * compte — et avec le secret de service, il pourrait alors les parcourir
 * tous. Le secret de service dit « tu es un site », pas « tu es cette
 * personne » ; les deux preuves s'exigent ENSEMBLE.
 *
 * ⚠️ La tentation était réelle et mesurée : `/api/session` REND déjà
 *    l'identifiant du compte au site. L'enchaînement « je lis l'id, puis
 *    je le repasse en `?compte=` » MARCHERAIT. C'est exactement pour ça
 *    qu'il faut un banc : le principe ne protège pas contre un
 *    identifiant inventé par un navigateur, il protège contre CE SITE-LÀ,
 *    compromis. Rien dans le comportement observable ne distingue les deux
 *    montages — sauf ce fichier.
 *
 * ⭐ PAR HTTP, ET PAS SUR LES FONCTIONS, pour la même raison que
 *   `admin.test.ts` : le défaut qu'on craint est un défaut de PLACEMENT.
 *   `server.ts` résout `?compte=` à mi-chemin et rend « compte inconnu »
 *   à tout ce qui passe dessous. Une route posée du mauvais côté de cette
 *   ligne répondrait 404 sur une session parfaitement valide, sans une
 *   erreur. Aucun banc sur les fonctions ne peut voir ça.
 */

const dossier = mkdtempSync(join(tmpdir(), 'veveid-service-'));
const SECRET = 'secret-de-service-de-banc-91af3c';
const SITE = 'veveprice';
const W_VERIFIE = '0x' + '1a'.repeat(20);
const W_NU = '0x' + '2b'.repeat(20);

let serveur: Server;
let racine = '';

/** Le compte qui a prouvé son portefeuille, et sa session côté site. */
let idVerifie = '', sidVerifie = '';
/** Le membre inscrit par courriel, sans portefeuille prouvé. */
let idNu = '', sidNu = '';
/** Une session ouverte puis fermée. */
let sidRevoque = '';

/**
 * ⭐⭐⭐ LE COMPTEUR DE REFUS SERVIS — la leçon du 140‑3, payée le 12/08.
 *
 * Un faux qui ne sert jamais sa branche de refus ne prouve rien : il est
 * vert parce qu'il n'a rien rencontré, et il ressemble trait pour trait à
 * un banc qui a tout vérifié. C'est ce compteur, resté à zéro, qui avait
 * révélé le cas manquant du lot précédent. Il est donc ici AVANT d'en
 * avoir besoin, et le dernier test de ce fichier le relit.
 */
const refusServis = new Map<number, number>();

before(async () => {
  process.env.DB_PATH = join(dossier, 'service.db');
  process.env.SITE_DEFAUT = SITE;
  process.env.SESSION_SECRET = 'secret-de-banc-0123456789abcdef';
  process.env.ID_SERVICE = SECRET;
  process.env.URL_PUBLIQUE = 'https://id.exemple.net';
  process.env.JEUX = 'veveprice=https://veveprice.com';

  const s = await import('../server.ts');
  serveur = s.serveur;
  const av = await import('../src/avoirs.ts');
  const df = await import('../src/defi.ts');
  const ss = await import('../src/sessions.ts');

  /**
   * ⭐ LES DEUX COMPTES SE FABRIQUENT PAR LES VRAIES FONCTIONS — et le
   *   portefeuille se prouve par `defi.lier()`, le SEUL chemin qui a le
   *   droit d'écrire `verifie`. Un `UPDATE comptes SET verifie=1` dans le
   *   banc aurait fabriqué la condition au lieu de l'obtenir : le banc
   *   aurait alors mesuré sa propre mise en scène.
   */
  const cv = av.creerOuLireCompteParEmail(SITE, 'verifie@exemple.fr');
  idVerifie = cv.id;
  av.poserPortefeuille(idVerifie, W_VERIFIE);
  const bilan = df.lier(idVerifie, W_VERIFIE);
  assert.ok(bilan.ok, `la preuve doit passer : ${bilan.message}`);

  /**
   * Les avoirs se posent par `synchroniser()`, avec une lecture de chaîne
   * simulée. ⛔ On ne tape pas CollectScan depuis un banc : il serait
   * rouge le jour où un service tiers a une mauvaise minute, et ce rouge
   * ne dirait rien de notre code.
   */
  await av.synchroniser(idVerifie, W_VERIFIE, (async () => ({
    liste: [
      { name: 'Iron Man Mark III', edition: 42, rarity: 'rare', image: 'https://exemple/1.png' },
      { name: 'Spider-Man Classic', edition: 7, rarity: 'common', image: null },
    ],
    complet: true,
  })) as any);

  const cn = av.creerOuLireCompteParEmail(SITE, 'nu@exemple.fr');
  idNu = cn.id;
  av.poserPortefeuille(idNu, W_NU); // adresse tapée, JAMAIS prouvée

  sidVerifie = ss.ouvrirSession(idVerifie);
  sidNu = ss.ouvrirSession(idNu);
  sidRevoque = ss.ouvrirSession(idVerifie);
  assert.equal(ss.revoquer(sidRevoque), true);

  await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
  const a = serveur.address() as { port: number };
  racine = `http://127.0.0.1:${a.port}`;
});

after(async () => {
  await new Promise<void>((r) => serveur.close(() => r()));
  const m = await import('../src/db.ts');
  m.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

/**
 * ⚠️ `secret: null` veut dire « aucun en-tête `x-service` », ce qui n'est
 *    PAS la même chose qu'un secret vide : le premier est un appel de
 *    navigateur, le second un site mal configuré. Les deux doivent être
 *    refusés, et on éprouve les deux.
 */
async function demande(chemin: string, secret: string | null = SECRET) {
  const r = await fetch(racine + chemin, {
    redirect: 'manual',
    headers: secret === null ? {} : { 'x-service': secret },
  });
  if (r.status >= 400) refusServis.set(r.status, (refusServis.get(r.status) ?? 0) + 1);
  const texte = await r.text();
  let corps: any = null;
  try { corps = JSON.parse(texte); } catch { /* pas du JSON : le test le dira */ }
  return { status: r.status, corps, texte };
}

// ═══════════════════════════════════════════════════════════════════════
// ① LA PORTE — le secret de service
// ═══════════════════════════════════════════════════════════════════════

test('🔴 sans x-service, l’API de service ne rend RIEN', async () => {
  for (const chemin of [
    `/api/avoirs?sid=${sidVerifie}`,
    `/api/avoirs?compte=${idVerifie}`,
    `/api/session?sid=${sidVerifie}`,
    `/api/compte?compte=${idVerifie}`,
  ]) {
    const r = await demande(chemin, null);
    assert.equal(r.status, 401, `« ${chemin} » doit être refusée sans secret`);
    assert.ok(!r.texte.includes(W_VERIFIE), '⛔ aucun portefeuille ne doit sortir');
    assert.ok(!r.texte.includes('verifie@exemple.fr'), '⛔ aucune adresse non plus');
  }
});

test('🔴 un mauvais secret est refusé, et un secret VIDE aussi', async () => {
  for (const mauvais of ['pas-le-bon', '', SECRET + 'x', SECRET.slice(0, -1)]) {
    const r = await demande(`/api/avoirs?sid=${sidVerifie}`, mauvais);
    assert.equal(r.status, 401, `« ${mauvais || '(vide)'} » ne doit pas ouvrir`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ② LA RÉSOLUTION PAR SESSION — ce que le lot ajoute
// ═══════════════════════════════════════════════════════════════════════

test('⭐ /api/avoirs?sid= rend les collectibles de CETTE session', async () => {
  const r = await demande(`/api/avoirs?sid=${sidVerifie}`);
  assert.equal(r.status, 200, `attendu 200, reçu ${r.status} — ${r.texte.slice(0, 120)}`);
  assert.equal(r.corps.compte, idVerifie, 'c’est bien le compte de la session');
  assert.equal(r.corps.wallet, W_VERIFIE);
  assert.equal(r.corps.avoirs.length, 2);
  assert.deepEqual(r.corps.avoirs.map((a: any) => a.nom).sort(),
    ['Iron Man Mark III', 'Spider-Man Classic']);
  /**
   * ⭐⭐ `sync` EST DANS LA RÉPONSE, ET CE N'EST PAS UN DÉTAIL D'AFFICHAGE.
   *    Il porte `complet` : sans lui, le site ne peut pas distinguer
   *    « cette personne n'a aucun collectible » de « je n'ai pas réussi à
   *    lire la chaîne ». Aplatir les deux afficherait « aucun collectible »
   *    à quelqu'un qui en a trois cents.
   */
  assert.ok(r.corps.sync, 'le journal de lecture doit accompagner la liste');
  assert.equal(r.corps.sync.complet, 1);
});

test('🔴 un sid inconnu rend 404, pas une liste vide', async () => {
  const r = await demande('/api/avoirs?sid=ce-sid-na-jamais-existe');
  assert.equal(r.status, 404);
  /**
   * ⚠️ Une liste vide en 200 serait le pire des deux mondes : le site
   *    afficherait « vous n'avez aucun collectible » à quelqu'un dont la
   *    session vient simplement d'expirer. Le 404 est ce qui lui permet
   *    de dire « reconnectez-vous » au lieu de mentir.
   */
  assert.ok(!Array.isArray(r.corps?.avoirs), '⛔ surtout pas une liste');
});

test('🔴🔴 UN IDENTIFIANT DE COMPTE N’EST PAS UN SID', async () => {
  /**
   * ⭐⭐⭐ LE BANC LE PLUS IMPORTANT DU FICHIER. Il ne mesure pas une
   *   fonctionnalité, il mesure une CONFUSION qui serait invisible.
   *   Une résolution écrite `lireCompte(sid ?? compte)` rendrait 200 ici,
   *   ferait passer tous les autres tests, et aurait discrètement rétabli
   *   le pouvoir de DÉSIGNER un compte que ce lot existe pour retirer.
   */
  const r = await demande(`/api/avoirs?sid=${idVerifie}`);
  assert.equal(r.status, 404,
    'un identifiant de compte passé en sid ne doit RIEN ouvrir');
});

test('🔴 une session révoquée n’ouvre plus rien', async () => {
  const r = await demande(`/api/avoirs?sid=${sidRevoque}`);
  assert.equal(r.status, 404, 'la déconnexion est une révocation, pas un cookie effacé');
});

test('⭐ portefeuille non prouvé ⇒ 409, et le 409 se distingue du 404', async () => {
  const r = await demande(`/api/avoirs?sid=${sidNu}`);
  assert.equal(r.status, 409,
    'un membre sans preuve n’est pas un inconnu : il n’a simplement rien à montrer');
  /**
   * ⭐⭐ CE SONT DEUX PHRASES DIFFÉRENTES POUR LA PERSONNE : le 404 dit
   *    « reconnectez-vous », le 409 dit « vérifiez votre portefeuille ».
   *    Les confondre enverrait vers l'écran de connexion quelqu'un qui est
   *    déjà connecté — la boucle de redirections du lot 89, remise au goût
   *    du jour.
   */
  assert.notEqual(r.status, 404);
});

test('🔴🔴 sid ET compte ensemble : c’est le SID qui décide', async () => {
  /**
   * ⭐⭐⭐ LA VOIE DE CONTOURNEMENT LA PLUS PLAUSIBLE, ET ELLE EST MUETTE.
   *   Un site compromis n'a pas besoin de retirer le `sid` : il lui suffit
   *   d'ajouter `&compte=`. Si la résolution lisait `compte` en premier —
   *   ou en repli quand le `sid` ne donne rien — le pouvoir de désigner
   *   reviendrait par la porte de service, sans qu'aucune autre mesure ne
   *   change.
   *
   * On envoie donc le `sid` du compte SANS preuve avec l'identifiant du
   * compte vérifié. La réponse tranche à elle seule :
   *   · 409 ⇒ le sid a décidé            ✅
   *   · 200 ⇒ le compte a décidé          🔴 le site vient de désigner
   */
  const r = await demande(`/api/avoirs?sid=${sidNu}&compte=${idVerifie}`);
  assert.equal(r.status, 409,
    '🔴 un 200 ici veut dire que le paramètre `compte` a gagné : le site a DÉSIGNÉ un compte');
  assert.ok(!r.texte.includes(W_VERIFIE),
    '⛔ et rien du compte désigné ne doit avoir fuité dans la réponse');
});

test('🔴🔴 un sid qui NE RÉSOUT PAS ne se rabat JAMAIS sur ?compte=', async () => {
  /**
   * ⭐⭐⭐ CE BANC A ÉTÉ AJOUTÉ APRÈS COUP, LE 12/08, ET C'EST TOUT SON
   *   INTÉRÊT — LE TEST PRÉCÉDENT NE SUFFISAIT PAS.
   *
   * Le test au-dessus éprouve `sid` + `compte` avec un `sid` qui RÉSOUT.
   * Une implémentation écrite en repli :
   *     sid ? (parSession(sid) ?? parCompte(compte)) : parCompte(compte)
   * ne déclenche alors JAMAIS son repli, et passe tous les autres tests
   * sans en rougir un seul. Ce n'est pas une hypothèse : ce code exact a
   * été injecté dans `server.ts` et les quatorze tests sont restés verts.
   *
   * ⭐ UNE BRANCHE DE REPLI NE SE CONTRÔLE QU'EN LA FAISANT SERVIR. Il
   *   faut donc les deux moitiés ensemble : un `sid` qui ÉCHOUE, et un
   *   `compte` qui, lui, réussirait — sinon le 404 ne prouve rien, il
   *   pourrait venir du compte aussi.
   *
   * ⚠️ Le `sid` VIDE est dans la liste exprès. `?sid=&compte=<id>` est la
   *    forme la plus banale du bug côté site, et c'est aussi la plus
   *    dangereuse : si « vide » se lit « absent », la désignation revient
   *    sans qu'aucun code n'ait l'air fautif. Un `sid` PRÉSENT décide,
   *    même vide.
   */
  const cas: [string, string][] = [
    ['ce-sid-na-jamais-existe', 'un sid inventé'],
    [sidRevoque, 'une session révoquée'],
    [idVerifie, 'un identifiant de compte déguisé en sid'],
    ['', 'un sid présent mais VIDE'],
  ];
  for (const [sid, quoi] of cas) {
    const r = await demande(`/api/avoirs?sid=${sid}&compte=${idVerifie}`);
    assert.equal(r.status, 404,
      `🔴 ${quoi} + un compte valide ⇒ le repli a servi, et le site vient de DÉSIGNER un compte`);
    assert.ok(!r.texte.includes(W_VERIFIE), '⛔ et rien n’a fuité');
  }

  // ⭐ LE TÉMOIN DE CE BANC : sans lui, les quatre 404 ci-dessus pourraient
  //   venir d'un `?compte=` qui ne marche plus du tout — auquel cas ils ne
  //   prouveraient rien. On vérifie que la moitié « qui réussirait »
  //   réussit bien.
  const seul = await demande(`/api/avoirs?compte=${idVerifie}`);
  assert.equal(seul.status, 200,
    'auto-contrôle : sans sid, ce même compte DOIT répondre — sinon les 404 ci-dessus sont vides de sens');
});

// ═══════════════════════════════════════════════════════════════════════
// ③ LA NON-RÉGRESSION — les jeux appellent encore par `?compte=`
// ═══════════════════════════════════════════════════════════════════════
/**
 * ⚠️ `?compte=` N'EST PAS RETIRÉ PAR CE LOT, et ce n'est pas un oubli.
 *    MightysArena appelle cette route ainsi. Un jeu n'a pas de session de
 *    site : il part du portefeuille, et il détient légitimement
 *    l'identifiant du compte qu'il a lui-même fait créer. La règle « le
 *    site ne désigne pas » vise les SITES, qui ont un `sid` ; l'étendre
 *    aux jeux casserait le seul consommateur actuel pour un gain nul.
 */
test('⭐ ?compte= rend toujours les avoirs — les jeux ne cassent pas', async () => {
  const r = await demande(`/api/avoirs?compte=${idVerifie}`);
  assert.equal(r.status, 200, `attendu 200, reçu ${r.status}`);
  assert.equal(r.corps.avoirs.length, 2);
});

test('⭐ ?compte= inconnu rend 404, comme avant', async () => {
  const r = await demande('/api/avoirs?compte=ce-compte-nexiste-pas');
  assert.equal(r.status, 404);
});

test('⭐ /api/compte n’est pas touchée par le lot', async () => {
  const r = await demande(`/api/compte?compte=${idVerifie}`);
  assert.equal(r.status, 200);
  assert.equal(r.corps.palier, 'member');
});

// ═══════════════════════════════════════════════════════════════════════
// ④ /api/session — la route que le site appelle DÉJÀ, et que personne ne gardait
// ═══════════════════════════════════════════════════════════════════════

test('⭐ /api/session?sid= rend l’état, et pas plus', async () => {
  const r = await demande(`/api/session?sid=${sidVerifie}`);
  assert.equal(r.status, 200);
  assert.equal(r.corps.compte, idVerifie);
  assert.equal(r.corps.verifie, true);
  assert.equal(r.corps.palier, 'member');
  assert.equal(r.corps.supprime, false);
});

test('🔴 /api/session avec un identifiant de compte en guise de sid ⇒ 404', async () => {
  const r = await demande(`/api/session?sid=${idVerifie}`);
  assert.equal(r.status, 404, 'même confusion, même refus — la règle vaut pour les deux routes');
});

// ═══════════════════════════════════════════════════════════════════════
// ⑤ 🔴🔴🔴 LE TÉMOIN — ce fichier a-t-il VRAIMENT rencontré des refus ?
// ═══════════════════════════════════════════════════════════════════════
/**
 * ⭐⭐⭐ TOUT CE QUI PRÉCÈDE PEUT ÊTRE VERT SANS RIEN AVOIR PROUVÉ.
 *
 * Un `assert.equal(r.status, 401)` qui n'est jamais atteint — parce qu'une
 * boucle tourne à vide, parce qu'un `before` a silencieusement échoué,
 * parce qu'un chemin a été renommé — laisse un test vert. Le verdict rendu
 * sur zéro élément ressemble exactement au verdict rendu sur dix.
 *
 * Ce test-ci ne mesure donc pas le serveur : il mesure LE BANC. Il exige
 * que chacune des trois branches de refus ait été réellement SERVIE.
 */
test('🔴 les trois branches de refus ont été SERVIES, pas seulement écrites', () => {
  for (const [code, quoi] of [
    [401, 'le secret de service'],
    [404, 'la session ou le compte inconnus'],
    [409, 'le portefeuille non prouvé'],
  ] as [number, string][]) {
    const n = refusServis.get(code) ?? 0;
    assert.ok(n > 0,
      `aucun ${code} servi : la branche « ${quoi} » n’a jamais été atteinte. `
      + 'Ce fichier est vert parce qu’il n’a rien rencontré, pas parce que tout va bien.');
  }
  // ⭐ Et l'auto-contrôle du compteur lui-même : il ne doit compter QUE des
  //   refus. S'il attrapait aussi les 200, la garantie ci-dessus se
  //   satisferait du chemin nominal et ne prouverait plus rien.
  assert.equal(refusServis.get(200), undefined,
    'le compteur ne doit enregistrer que les réponses ≥ 400');
});
