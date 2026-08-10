// ⚠️ DEPOT : VeVePreda/veveid   ·   CHEMIN : test/admin.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';

/**
 * 🔥 LOT 108 — LA PAGE D'EXPLOITATION, JOUÉE PAR HTTP.
 *
 * ⭐⭐⭐ POURQUOI PAR HTTP ET PAS SUR LES FONCTIONS. Le défaut que ce banc
 * doit attraper n'est pas dans `admin.ts` : il est dans le PLACEMENT de la
 * route. `server.ts` porte, à mi-chemin, une ligne
 *     `const compte = …; if (!compte) return … vers(res, '/');`
 * qui avale tout ce qui la suit pour qui n'a pas de compte joueur — et un
 * administrateur n'en a pas. Une route d'admin posée dessous répondrait 302
 * vers l'accueil, sans une erreur, et on conclurait « le lot n'est pas
 * déposé ». Aucun banc sur les fonctions ne peut voir ça.
 * ⭐ C'est le premier banc HTTP de ce dépôt, et c'est ce qui le justifie :
 *   il mesure la CHAÎNE, pas la pièce.
 */

const dossier = mkdtempSync(join(tmpdir(), 'veveid-admin-'));
const JETON = 'jeton-de-banc-3cf1a9';
const W = '0x' + 'ab'.repeat(20);
const EMAIL = 'preda@exemple.net';

let serveur: Server;
let racine = '';

before(async () => {
  const f = join(dossier, 'admin.db');
  const db = new DatabaseSync(f);
  db.exec(`CREATE TABLE comptes (
    id TEXT PRIMARY KEY, wallet TEXT, email TEXT, verifie INTEGER NOT NULL DEFAULT 0,
    verifie_le TEXT, cree_le TEXT NOT NULL, abonne_jusqu_a TEXT, supprime_le TEXT);
  CREATE UNIQUE INDEX idx_comptes_wallet ON comptes(wallet) WHERE wallet IS NOT NULL;`);
  db.prepare('INSERT INTO comptes (id, wallet, email, verifie, verifie_le, cree_le) VALUES (?,?,?,?,?,?)')
    .run('juillet', W, EMAIL, 1, '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z');
  db.close();

  process.env.DB_PATH = f;
  process.env.SITE_DEFAUT = 'veveprice';
  process.env.SESSION_SECRET = 'secret-de-banc-0123456789abcdef';
  process.env.ADMIN_TOKEN = JETON;
  process.env.JEUX = 'veveprice=https://veveprice.com';
  process.env.URL_PUBLIQUE = 'https://id.exemple.net';

  const s = await import('../server.ts');
  serveur = s.serveur;
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

/** ⚠️ `redirect: 'manual'` — c'est le CODE qu'on mesure, pas la destination. */
const va = (chemin: string, cookie?: string) =>
  fetch(racine + chemin, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const poste = (chemin: string, corps: string, cookie?: string) =>
  fetch(racine + chemin, {
    method: 'POST', redirect: 'manual', body: corps,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  });

/** Le cookie d'exploitation, obtenu comme un humain : par l'échange. */
async function ouvrirSession(): Promise<string> {
  const r = await va(`/admin?k=${JETON}`);
  const brut = r.headers.getSetCookie().find((c) => c.startsWith('veveid_adm='));
  assert.ok(brut, 'l\'échange doit poser le cookie d\'exploitation');
  return brut.split(';')[0];
}

// ═══════════════════════════════════════════════════════════════════════
// LA PORTE
// ═══════════════════════════════════════════════════════════════════════
test('🔴 sans cookie, /admin est INDISCERNABLE d\'une adresse qui n\'existe pas', async () => {
  const admin = await va('/admin');
  const nimporte = await va('/cette-adresse-nexiste-pas');
  assert.equal(admin.status, nimporte.status,
    'même code que n\'importe quelle adresse inconnue — un 404 ou un 401 annoncerait qu\'il y a quelque chose ici');
  assert.equal(admin.headers.get('location'), nimporte.headers.get('location'));
  const corps = await admin.text();
  assert.ok(!corps.includes('Exploitation'), 'aucun mot de la page ne doit sortir');
});

test('🔴 un mauvais jeton ne se distingue pas non plus', async () => {
  const r = await va('/admin?k=pas-le-bon-jeton');
  const nimporte = await va('/cette-adresse-nexiste-pas');
  assert.equal(r.status, nimporte.status);
  assert.equal(r.headers.getSetCookie().length, 0, 'et surtout : aucun cookie posé');
});

test('⭐ le bon jeton s\'échange contre un cookie, et l\'URL est NETTOYÉE', async () => {
  const r = await va(`/admin?k=${JETON}`);
  assert.equal(r.status, 302, 'la redirection est ce qui sort le secret de la barre d\'adresse');
  assert.equal(r.headers.get('location'), '/admin', 'et elle repointe sur la page, sans le jeton');
  const c = r.headers.getSetCookie().find((x) => x.startsWith('veveid_adm='));
  assert.ok(c);
  assert.match(c!, /HttpOnly/i);
  assert.match(c!, /SameSite=Strict/i, 'le cookie ne doit JAMAIS partir depuis un autre site');
  assert.match(c!, /Path=\/admin/i);
});

test('la page s\'ouvre avec le cookie, et se referme', async () => {
  const cookie = await ouvrirSession();
  const r = await va('/admin', cookie);
  assert.equal(r.status, 200);
  const corps = await r.text();
  assert.ok(corps.includes('Exploitation'));
  assert.ok(corps.includes('veveprice'), 'les comptes sont comptés par site');

  const sortie = await poste('/admin/sortir', '', cookie);
  assert.equal(sortie.status, 302);
  assert.ok(sortie.headers.getSetCookie().some((x) => /veveid_adm=;/.test(x) && /Max-Age=0/.test(x)));
});

// ═══════════════════════════════════════════════════════════════════════
// ⛔ CE QUI NE DOIT JAMAIS SORTIR
// ═══════════════════════════════════════════════════════════════════════
/**
 * ⭐⭐ CE BANC LIT LE HTML RENDU, PAS LES FONCTIONS QUI LE FABRIQUENT. Une
 * règle vérifiée à l'entrée se contourne par un chemin qu'on n'avait pas
 * prévu ; une règle vérifiée sur la SORTIE ne se contourne pas. Même famille
 * que `test:fuite` sur veveprice.
 */
test('⛔ la page ne contient AUCUNE adresse en clair', async () => {
  const cookie = await ouvrirSession();
  const corps = await (await va('/admin', cookie)).text();
  assert.ok(!corps.includes(EMAIL), 'aucune adresse e-mail');
  assert.ok(!corps.includes(W), 'aucun portefeuille');
  assert.ok(!/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(corps.replace(/•/g, '')),
    'et aucune adresse d\'aucune sorte, même une qu\'on n\'aurait pas prévue');
});

test('⛔ la recherche ne rend l\'AUTRE identifiant que masqué', async () => {
  const cookie = await ouvrirSession();

  const parWallet = await (await poste('/admin/chercher', `q=${encodeURIComponent(W)}`, cookie)).text();
  assert.ok(parWallet.includes('•'), 'un indice masqué doit apparaître');
  assert.ok(!parWallet.includes(EMAIL), '⛔ jamais l\'adresse entière');
  assert.ok(!parWallet.includes(W), '⛔ ni le terme cherché, qui repartirait dans le HTML');

  const parEmail = await (await poste('/admin/chercher', `q=${encodeURIComponent(EMAIL)}`, cookie)).text();
  assert.ok(parEmail.includes('•'));
  assert.ok(!parEmail.includes(W));
  assert.ok(!parEmail.includes(EMAIL));
});

test('⭐ un terme qui n\'est ni un courriel ni un portefeuille ne cherche RIEN', async () => {
  const cookie = await ouvrirSession();
  const corps = await (await poste('/admin/chercher', 'q=preda', cookie)).text();
  assert.ok(corps.includes('ne ressemble ni'),
    'on le DIT — sinon « rien trouvé » se lit « ce compte n\'existe pas », ce qui est faux');
});

test('une adresse inconnue rend « aucun compte », pas une erreur', async () => {
  const cookie = await ouvrirSession();
  const corps = await (await poste('/admin/chercher', 'q=inconnu%40exemple.net', cookie)).text();
  assert.ok(corps.includes('Aucun compte'));
});

// ═══════════════════════════════════════════════════════════════════════
// LA SONDE PUBLIQUE
// ═══════════════════════════════════════════════════════════════════════
test('⭐ /sante déclare la forme de la base, sans rien révéler', async () => {
  const s = await (await va('/sante')).json() as any;
  assert.equal(s.base.ouverte, true);
  assert.equal(s.base.site_present, true);
  assert.equal(typeof s.base.migrations, 'number');
  // ⛔ Aucun comptage de comptes, aucun nom d'index : la forme n'identifie
  //    personne, la population si.
  assert.deepEqual(Object.keys(s.base).sort(), ['migrations', 'ouverte', 'site_present']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴🔴🔴 LOT 122 — LE SEUL GESTE QUI ÉCRIT
// ═══════════════════════════════════════════════════════════════════════════
/**
 * CE QUE CE BANC GARDE, ET POURQUOI IL COMPTE PLUS QUE SA TAILLE.
 * `accorderAbonnement()` existait depuis des semaines, importée par
 * `server.ts` et appelée par PERSONNE en dehors des tests. Le palier
 * `crevette` se gagne par `abonne_jusqu_a > maintenant` : AUCUN COMPTE AU
 * MONDE ne pouvait donc l'atteindre, et tout ce que veveprice vend était
 * fermé à 100 % des humains comme à 100 % des robots.
 * ⭐⭐⭐ *Une protection qui bloque tout le monde n'est pas stricte, elle est
 * cassée* — et de l'extérieur les deux se ressemblent exactement.
 * ⛔ Le piège qui l'a fait durer : un IMPORT SANS APPEL. Un `grep` trouvait
 *   la fonction dans le fichier des routes, ce qui suffisait à conclure
 *   qu'elle était branchée. *Un import sans appel met la preuve au mauvais
 *   endroit.*
 */
test('🔴 le geste d’abonnement fait passer le palier à crevette', async () => {
  const cookie = await ouvrirSession();
  const av = await import('../src/avoirs.ts');

  assert.equal(av.paliDe(av.lireCompte('juillet')), 'member', 'avant : membre simple');

  const r = await poste('/admin/abonner', 'ref=juillet&jours=30', cookie);
  assert.equal(r.status, 200);
  assert.equal(av.paliDe(av.lireCompte('juillet')), 'crevette', 'après : abonné');

  // ⭐ ET LE CUMUL : un second geste PROLONGE, il ne remet pas à zéro. Sans ce
  //   contrôle, « accorder 30 jours » à quelqu'un qui en a déjà 20 lui en
  //   retirerait 20 — une erreur invisible, qui ne se voit qu'un mois après.
  const fin1 = av.lireCompte('juillet')!.abonne_jusqu_a!;
  await poste('/admin/abonner', 'ref=juillet&jours=30', cookie);
  assert.ok(av.lireCompte('juillet')!.abonne_jusqu_a! > fin1, 'le second geste prolonge');
});

test('⛔ la durée est bornée, et les bornes sont refusées côté serveur', async () => {
  const cookie = await ouvrirSession();
  const av = await import('../src/avoirs.ts');
  const avant = av.lireCompte('juillet')!.abonne_jusqu_a;

  // ⚠️ `min`/`max` dans le HTML est du CONFORT : un POST à la main l'ignore.
  //    La borne qui protège est celle du serveur, et c'est elle qu'on éprouve.
  for (const corps of ['ref=juillet&jours=0', 'ref=juillet&jours=401',
                       'ref=juillet&jours=abc', 'ref=juillet&jours=1.5',
                       'ref=juillet&jours=-30', 'ref=juillet']) {
    const r = await poste('/admin/abonner', corps, cookie);
    assert.equal(r.status, 200, corps);
    assert.equal(av.lireCompte('juillet')!.abonne_jusqu_a, avant,
      `⛔ « ${corps} » ne doit RIEN changer`);
  }
});

test('⛔ une référence inconnue ne crée rien et le dit', async () => {
  const cookie = await ouvrirSession();
  const r = await poste('/admin/abonner', 'ref=personne&jours=30', cookie);
  const corps = await r.text();
  assert.ok(corps.includes('Compte inconnu'), 'le message le dit');
});

/**
 * ⭐⭐⭐ LE TÉMOIN NON DÉSARMÉ, et c'est le contrôle le plus important des
 * quatre : sans lui, les trois précédents prouveraient seulement que le geste
 * marche — jamais qu'il est FERMÉ. Une route qui écrit en base et qu'on
 * atteint sans session d'exploitation, c'est un abonnement gratuit pour qui
 * connaît l'adresse. C'est exactement ce qu'était la « démo » du 01/08.
 */
test('⛔ sans session d’exploitation, le geste n’écrit rien', async () => {
  const av = await import('../src/avoirs.ts');
  const avant = av.lireCompte('juillet')!.abonne_jusqu_a;
  const r = await poste('/admin/abonner', 'ref=juillet&jours=30', '');
  assert.notEqual(r.status, 200, 'la route ne doit pas répondre 200 sans cookie');
  assert.equal(av.lireCompte('juillet')!.abonne_jusqu_a, avant,
    '⛔ la base ne doit PAS avoir bougé');
});

/**
 * ⛔ ET LA RÈGLE QUI A FAIT ÉCHOUER MA PREMIÈRE VERSION : après le geste, la
 * page ne doit toujours contenir AUCUNE identité en clair. Mon formulaire
 * portait l'e-mail dans un champ caché ; il porte désormais une référence
 * opaque. Ce contrôle est ce qui empêche d'y revenir sans s'en apercevoir.
 */
test('⛔ après le geste, toujours aucune adresse en clair', async () => {
  const cookie = await ouvrirSession();
  const r = await poste('/admin/abonner', 'ref=juillet&jours=30', cookie);
  const corps = await r.text();
  assert.ok(!corps.includes(EMAIL), 'aucune adresse e-mail');
  assert.ok(!corps.includes(W), 'aucun portefeuille');
});

/**
 * ⭐ Et le formulaire existe VRAIMENT dans la page de recherche : sans lui,
 * tout ce qui précède mesurerait une route que personne ne peut atteindre —
 * la moitié « qui écrit » d'un circuit dont la moitié « qui appelle »
 * manquerait. C'est la faute que ce lot répare, refaite d'un cran.
 */
test('⭐ la page de recherche PORTE le formulaire d’abonnement', async () => {
  const cookie = await ouvrirSession();
  const corps = await (await poste('/admin/chercher', `q=${encodeURIComponent(W)}`, cookie)).text();
  assert.ok(corps.includes('/admin/abonner'), 'le formulaire est là');
  assert.ok(/name="ref" value="[^"]+"/.test(corps), 'et il porte une référence');
});
