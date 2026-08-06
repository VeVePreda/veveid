import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expediteur, EXPEDITEUR_DEFAUT, nomExpediteur } from './courriel.ts';

/**
 * 🔴🔴 CE FICHIER EXISTE POUR RENDRE BRUYANTE LA PANNE LA PLUS DANGEREUSE
 * DU DÉPLOIEMENT : L'OUBLI DU VOLUME PERSISTANT.
 *
 * Sans volume monté sur `/data`, tout FONCTIONNE : le service répond, on
 * crée des comptes, on prouve la propriété d'un portefeuille, les jeux
 * ouvrent leurs portes. Puis au premier redéploiement — un simple `git push`
 * suffit — le conteneur est remplacé et **toute la base part avec lui**.
 * Aucune erreur, aucun message.
 *
 * ⚠️ ICI LA PERTE EST PIRE QUE POUR UN JEU. Ce service porte la liaison
 * `compte ↔ portefeuille`, et cette liaison a COÛTÉ QUELQUE CHOSE au
 * joueur : il a mis deux collectibles en vente, attendu, annulé. La lui
 * faire refaire parce qu'un champ Coolify était vide est la meilleure façon
 * de le perdre. Et comme tous les jeux dépendent de ce service, la perte
 * est simultanée sur TOUS.
 *
 * Une panne silencieuse qui se déclenche au pire moment est la pire espèce
 * de panne. On la rend donc impossible à manquer.
 *
 * ⭐ Porté depuis MightysArena le 20/07/2026, après que la question « le
 * volume est-il vraiment monté ? » se soit posée sans qu'on puisse y
 * répondre autrement qu'en ouvrant un terminal. Un service doit savoir dire
 * lui-même s'il est correctement installé.
 */

export type Gravite = 'ok' | 'attention' | 'grave';
export interface Constat { gravite: Gravite; titre: string; detail: string; }

/**
 * Un dossier est-il un point de montage ?
 *
 * `/proc/self/mountinfo` liste ce que le noyau a réellement monté dans ce
 * conteneur. C'est la seule source qui distingue un volume Docker d'un
 * simple dossier créé dans l'image — et cette distinction est précisément
 * celle qui décide si les données survivent ou non.
 */
export function estUnMontage(chemin: string): boolean {
  const cible = resolve(chemin);
  try {
    for (const ligne of readFileSync('/proc/self/mountinfo', 'utf-8').split('\n')) {
      // Champ 5 = point de montage côté conteneur.
      const point = ligne.split(' ')[4];
      if (point && resolve(point) === cible) return true;
    }
  } catch {
    // Pas de /proc : on n'est pas dans un conteneur Linux (poste de dev,
    // tests). Ce n'est pas une alerte, c'est un contexte différent.
    return true;
  }
  return false;
}

/**
 * Faut-il exiger que le dossier de la base soit un volume ?
 *
 * ⚠️ La première version de ce contrôle (côté arcade) demandait « sommes-nous
 * dans un conteneur ? » et répondait par `/.dockerenv` ou les cgroups.
 * **Vérifié : ça ne tient pas.** Sur un cgroup v2, `/proc/1/cgroup` ne dit
 * plus rien d'utile (`0::/…`), et tous les environnements conteneurisés ne
 * posent pas `/.dockerenv`. Le contrôle le plus important du démarrage
 * serait donc resté MUET là où il compte le plus.
 *
 * On ne devine donc plus l'environnement : deux signes indépendants, un seul
 * suffit.
 *  1. `/.dockerenv` — posé par Docker, donc par Coolify.
 *  2. Le chemin `/data`, notre convention de déploiement documentée.
 * En développement (`./veve-id.db`, `/tmp/…`), aucun des deux ne s'applique
 * et le contrôle se tait, ce qui est le comportement voulu.
 */
export function exigeUnVolume(fichier: string): boolean {
  if (process.env.EXIGER_VOLUME === '1') return true;    // forçage explicite
  if (process.env.EXIGER_VOLUME === '0') return false;
  try { readFileSync('/.dockerenv'); return true; } catch { /* pas Docker */ }
  return sousData(fichier);
}

/**
 * Le chemin est-il `/data` ou dessous ?
 *
 * ⚠️ `startsWith('/data')` seul accepterait `/database` ou `/data-essai` : on
 * compare des SEGMENTS de chemin, pas des caractères. Fonction séparée pour
 * qu'elle soit testable sans dépendre de la présence de `/.dockerenv`, qui
 * varie selon l'endroit où tournent les tests.
 */
export function sousData(fichier: string): boolean {
  const p = resolve(fichier);
  return p === '/data' || p.startsWith('/data/');
}

function inscriptible(dossier: string): boolean {
  const t = `${dossier}/.essai-${process.pid}`;
  try {
    mkdirSync(dossier, { recursive: true });
    writeFileSync(t, 'x');
    unlinkSync(t);
    return true;
  } catch { return false; }
}

/** Tous les contrôles, sans rien afficher — pour pouvoir les tester. */
export function controlerDemarrage(): Constat[] {
  const c: Constat[] = [];
  const fichier = process.env.DB_PATH ?? './veve-id.db';
  const dossier = dirname(fichier);
  const surVolume = exigeUnVolume(fichier);

  // ── 1. LA PERSISTANCE ────────────────────────────────────────────────
  if (!inscriptible(dossier)) {
    c.push({
      gravite: 'grave',
      titre: `Le dossier de la base n'est pas inscriptible : ${dossier}`,
      detail: "Le service ne peut rien enregistrer : personne ne pourra se connecter. "
        + "Dans Coolify, verifiez que le stockage persistant est bien monte sur ce "
        + "chemin, et qu'il n'est pas en lecture seule.",
    });
  } else if (surVolume && !estUnMontage(dossier)) {
    c.push({
      gravite: 'grave',
      titre: `⚠️ AUCUN VOLUME PERSISTANT SUR ${dossier} — LES IDENTITÉS SERONT PERDUES`,
      detail: "Tout va sembler fonctionner, puis le PROCHAIN REDEPLOIEMENT effacera "
        + "comptes, portefeuilles verifies, avoirs et abonnements, sans le moindre "
        + "message — et chaque joueur devra REFAIRE la preuve de propriete (remettre "
        + "deux collectibles en vente, attendre, annuler). "
        + "Dans Coolify : ressource > Storages > Add > Volume Mount, "
        + `Destination Path = ${dossier}. Puis redeployer.`,
    });
  } else {
    c.push({
      gravite: 'ok',
      titre: `Base persistante : ${fichier}`,
      detail: surVolume ? 'volume monte, les identites survivront aux redeploiements'
        : 'hors deploiement (poste de developpement)',
    });
  }

  // ── 2. LES CLÉS ──────────────────────────────────────────────────────
  // Sans elles le service tourne, affiche ses pages… et n'émet aucun jeton :
  // le joueur prouve sa propriété puis reste bloqué à la porte du jeu.
  if (!process.env.ID_PRIVEE || !process.env.ID_PUBLIQUE) {
    c.push({
      gravite: 'grave',
      titre: 'ID_PRIVEE ou ID_PUBLIQUE absente : AUCUN JETON NE SERA ÉMIS',
      detail: "Le joueur pourra prouver sa propriete et sera quand meme refuse par le "
        + "jeu. Fabriquez la paire avec `node server.ts --cles`, puis posez-la dans "
        + "les variables d'environnement Coolify (⛔ pas dans les secrets GitHub : "
        + "personne ne les lit ici).",
    });
  }
  if (!process.env.ID_SERVICE) {
    c.push({
      gravite: 'attention',
      titre: "ID_SERVICE absente : l'API des avoirs est fermée aux jeux",
      detail: "Les jeux pourront identifier un joueur mais pas lire ses collectibles. "
        + "La meme valeur doit etre posee ici et dans chaque jeu.",
    });
  }

  // ── 3. LES JEUX DÉCLARÉS ─────────────────────────────────────────────
  // ⚠️ `JEUX` n'est pas un confort : c'est la LISTE BLANCHE D'ORIGINES qui
  // empêche ce service d'être une redirection ouverte. Vide, il est inutile ;
  // mal remplie, il refuse tout le monde avec « Adresse de retour refusée ».
  if (!process.env.JEUX) {
    c.push({
      gravite: 'grave',
      titre: 'JEUX est vide : AUCUN jeu ne peut utiliser ce service',
      detail: "Format : JEUX=loop=https://loop.digitalcollectible.net (separez par des "
        + "virgules). L'adresse doit correspondre AU CARACTERE PRES au SITE_URL du jeu.",
    });
  }

  // ── 4. L'INSCRIPTION PAR COURRIEL (lot 89) ───────────────────────────
  /**
   * ⭐⭐ CES DEUX MANQUES SONT SILENCIEUX EN PRODUCTION, ET C'EST POURQUOI
   *     ILS SONT ICI.
   *
   * Sans `URL_PUBLIQUE`, le formulaire d'inscription rend une erreur
   * générique et le journal seul dit pourquoi. Sans `BREVO_CLE`, la page
   * « vérifiez vos e-mails » s'affiche exactement pareil — puisqu'elle est
   * volontairement identique dans tous les cas — et personne ne reçoit
   * jamais rien. Le seul endroit où la panne peut se voir AVANT qu'un
   * visiteur la subisse, c'est ce cadre-là.
   */
  if (!process.env.URL_PUBLIQUE) {
    c.push({
      gravite: 'grave',
      titre: "URL_PUBLIQUE absente : AUCUN LIEN DE CONNEXION NE PEUT ETRE FABRIQUE",
      detail: "L'inscription par e-mail repondra 'momentanement indisponible'. "
        + "⛔ On ne se rabat PAS sur l'en-tete Host : il est ecrit par l'appelant, "
        + "et le lien partirait vers le serveur de qui le demande. "
        + "Posez URL_PUBLIQUE=https://id.digitalcollectible.net (sans barre finale).",
    });
  }
  if (!process.env.BREVO_CLE && process.env.COURRIEL_SIMULE !== '1') {
    c.push({
      gravite: 'grave',
      titre: 'BREVO_CLE absente : AUCUN COURRIEL NE PARTIRA',
      detail: "La page 'verifiez vos e-mails' s'affichera quand meme — elle est identique "
        + "dans tous les cas, expres — et personne ne recevra rien. "
        + "Cle API v3 dans Brevo > SMTP & API > Cles API (elle commence par xkeysib-). "
        + "L'expediteur doit etre sur un domaine authentifie chez Brevo : "
        + "veveprice.com (mail.veveprice.com n'est PAS un domaine d'envoi, "
        + "c'est le Return-Path).",
    });
  }

  /**
   * ⭐⭐⭐ CE CONTRÔLE PARLE MÊME QUAND TOUT VA BIEN, ET C'EST TOUT SON OBJET.
   *
   * Le 06/08, la question « depuis QUELLE adresse ce service envoie-t-il ? »
   * n'avait aucune réponse lisible : la variable vit dans Coolify, le défaut
   * vit dans le code, et le contrôle de démarrage SE TAISAIT dès que la
   * variable était posée. Deux lots ont été dépensés à chercher des valeurs
   * qu'aucune requête ne pouvait lire.
   *
   * ⭐ Un contrôle qui ne parle que pour signaler un manque laisse invisible
   *   la CONFIGURATION EFFECTIVE — c'est-à-dire la seule chose qu'on veut
   *   savoir quand un envoi échoue. On affiche donc toujours l'adresse
   *   retenue ET son origine : c'est la différence entre « la variable est
   *   posée » et « voici ce qui part ».
   * ⛔ Il ne remplace pas `GET /sante` (qui rend la même chose à distance) :
   *   celui-ci est lisible dans le journal AVANT le premier visiteur.
   */
  const deLaVariable = Boolean(process.env.BREVO_EXPEDITEUR);
  c.push({
    gravite: deLaVariable ? 'ok' : 'attention',
    titre: `Expediteur des courriels : ${nomExpediteur()} <${expediteur()}>`
      + (deLaVariable ? ' (BREVO_EXPEDITEUR)' : ' — DEFAUT DU CODE, aucune variable posee'),
    detail: "BREVO_EXPEDITEUR n'est pas posee : le service retombe sur "
      + `${EXPEDITEUR_DEFAUT}. Ce defaut est le bon domaine authentifie, mais il `
      + "n'a ete choisi par personne pour CE deploiement. Posez la variable "
      + "explicitement — un envoi refuse par Brevo ne se voit nulle part "
      + "ailleurs que dans /sante.",
  });
  if (process.env.COURRIEL_SIMULE === '1') {
    c.push({
      gravite: 'attention',
      titre: 'COURRIEL_SIMULE=1 : les liens de connexion sont ECRITS DANS LE JOURNAL',
      detail: "Aucun courriel ne part, et chaque lien s'affiche en clair dans les logs — "
        + "donc lisible par quiconque y a acces. ⛔ A ne JAMAIS laisser en production.",
    });
  }

  // ── 5. LA SESSION ────────────────────────────────────────────────────
  if (!process.env.SESSION_SECRET) {
    c.push({
      gravite: 'attention',
      titre: 'SESSION_SECRET absent',
      detail: 'Une cle ephemere est tiree au demarrage : tout le monde sera deconnecte '
        + 'a chaque redeploiement. Posez une longue chaine au hasard, DIFFERENTE de '
        + 'celle des jeux.',
    });
  }

  return c;
}

/**
 * Affiche le verdict. ⭐ On ne s'ARRÊTE PAS sur une erreur grave : un service
 * qui refuse de démarrer est une panne totale, alors qu'un service qui tourne
 * sans volume reste réparable tant qu'on s'en aperçoit. Le rôle de ce
 * contrôle est de faire qu'on s'en aperçoive — pas de décider à la place de
 * l'humain.
 */
export function annoncerDemarrage(): Constat[] {
  const constats = controlerDemarrage();
  const graves = constats.filter((x) => x.gravite === 'grave');

  console.log('┌─ Contrôle de démarrage ────────────────────────────────');
  for (const x of constats) {
    const marque = x.gravite === 'grave' ? '🔴' : x.gravite === 'attention' ? '🟠' : '✅';
    console.log(`│ ${marque} ${x.titre}`);
    if (x.gravite !== 'ok') console.log(`│    ${x.detail}`);
  }
  console.log('└────────────────────────────────────────────────────────');

  if (graves.length) {
    // Répété APRÈS le cadre : dans un journal qui défile, seule la dernière
    // ligne reste sous les yeux.
    console.error(`\n🔴🔴 ${graves.length} PROBLÈME(S) GRAVE(S) — voir ci-dessus. `
      + `Le service démarre quand même, mais NE L'OUVREZ PAS AUX JOUEURS en l'état.\n`);
  }
  return constats;
}
