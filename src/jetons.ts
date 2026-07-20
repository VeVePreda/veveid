import { createSign, createVerify, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';

/**
 * ⭐⭐ LE JETON D'IDENTITÉ — le contrat entre le service et les jeux.
 *
 * 🔴 POURQUOI UNE SIGNATURE À CLÉ PUBLIQUE, ET PAS UN SECRET PARTAGÉ.
 *
 * Un secret partagé serait plus simple : le service et les jeux
 * connaîtraient la même chaîne. Mais alors **n'importe quel jeu pourrait
 * FABRIQUER un jeton** — donc se déclarer propriétaire de n'importe quel
 * portefeuille. Le jour où un troisième jeu est écrit par quelqu'un
 * d'autre, ou déployé ailleurs, la faille devient réelle.
 *
 * Ici, seul le service SIGNE (clé privée). Les jeux ne peuvent que
 * VÉRIFIER (clé publique). Un jeu compromis ne peut usurper personne.
 *
 * ⭐ ET ÇA NE DÉPEND D'AUCUN DOMAINE. Un cookie partagé sur
 *    `.digitalcollectible.net` marcherait aujourd'hui, mais Preda a dit
 *    que ce domaine n'a pas vocation à héberger la plateforme. Un jeton
 *    signé traverse n'importe quelle frontière : on ne récrira rien le
 *    jour du déménagement.
 *
 * ⚠️ ES256 EXIGE UNE SIGNATURE BRUTE (r‖s, 64 octets). `node:crypto` rend
 *    du DER par défaut, plus long et de taille variable. Piège déjà payé
 *    sur les clés VAPID de Loop — d'où `dsaEncoding: 'ieee-p1363'`.
 */

const b64url = (b: Buffer) => b.toString('base64url');

export interface Charge {
  /** L'identifiant du compte sur la PLATEFORME. C'est la clé commune. */
  compte: string;
  /** Le portefeuille vérifié. */
  wallet: string;
  /** Le jeu à qui ce jeton est destiné. */
  jeu: string;
  /** Abonné jusqu'à — ISO, ou null. */
  abonne?: string | null;
  /** Émis le / expire le, en secondes. */
  iat: number;
  exp: number;
}

export function fabriquerCles(): { publique: string; privee: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publique: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url'),
    privee: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64url'),
  };
}

const clePrivee = (s: string) =>
  createPrivateKey({ key: Buffer.from(s, 'base64url'), format: 'der', type: 'pkcs8' });
export const clePublique = (s: string) =>
  createPublicKey({ key: Buffer.from(s, 'base64url'), format: 'der', type: 'spki' });

/**
 * ⚠️ DURÉE COURTE, ET C'EST VOULU. Le jeton ne sert qu'à FRANCHIR LA
 *    PORTE : le jeu le vérifie une fois, puis pose sa propre session. Un
 *    jeton qui traînerait dans un historique de navigation ou dans un
 *    journal de serveur ne doit plus rien ouvrir cinq minutes après.
 */
export const DUREE_S = 120;

export function signer(charge: Omit<Charge, 'iat' | 'exp'>, privee: string): string {
  const maintenant = Math.floor(Date.now() / 1000);
  const corps: Charge = { ...charge, iat: maintenant, exp: maintenant + DUREE_S };
  const entete = b64url(Buffer.from(JSON.stringify({ typ: 'VEVE-ID', alg: 'ES256' })));
  const utile = b64url(Buffer.from(JSON.stringify(corps)));
  const aSigner = `${entete}.${utile}`;
  const s = createSign('SHA256');
  s.update(aSigner); s.end();
  return `${aSigner}.${b64url(s.sign({ key: clePrivee(privee), dsaEncoding: 'ieee-p1363' }))}`;
}

export interface Verdict { ok: boolean; charge?: Charge; pourquoi?: string }

/**
 * ⭐ C'EST CETTE FONCTION QUE CHAQUE JEU EMBARQUE. Elle ne dépend que de
 *    `node:crypto` — aucune dépendance, aucun appel réseau.
 *
 * 🔴 L'ORDRE DES CONTRÔLES COMPTE : on vérifie la SIGNATURE avant de
 *    croire quoi que ce soit du contenu. Lire la charge d'abord pour
 *    « voir de qui il s'agit » reviendrait à faire confiance à un texte
 *    que n'importe qui peut écrire.
 */
export function verifier(jeton: string, publique: string, jeuAttendu: string): Verdict {
  const parts = String(jeton ?? '').split('.');
  if (parts.length !== 3) return { ok: false, pourquoi: 'forme invalide' };
  const [entete, utile, signature] = parts;

  let valide = false;
  try {
    const v = createVerify('SHA256');
    v.update(`${entete}.${utile}`); v.end();
    valide = v.verify(
      { key: clePublique(publique), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
  } catch { return { ok: false, pourquoi: 'signature illisible' }; }
  if (!valide) return { ok: false, pourquoi: 'signature invalide' };

  let charge: Charge;
  try { charge = JSON.parse(Buffer.from(utile, 'base64url').toString()); }
  catch { return { ok: false, pourquoi: 'charge illisible' }; }

  const maintenant = Math.floor(Date.now() / 1000);
  if (typeof charge.exp !== 'number' || charge.exp < maintenant)
    return { ok: false, pourquoi: 'jeton périmé' };
  /**
   * ⚠️ ON VÉRIFIE LE DESTINATAIRE. Sans ce contrôle, un jeton émis pour
   *    l'arcade ouvrirait Loop — et un jeu malveillant pourrait rejouer
   *    ailleurs le jeton qu'un joueur lui a présenté.
   */
  if (charge.jeu !== jeuAttendu)
    return { ok: false, pourquoi: `jeton émis pour « ${charge.jeu} »` };
  if (!charge.compte || !charge.wallet)
    return { ok: false, pourquoi: 'charge incomplète' };

  return { ok: true, charge };
}

/**
 * Le jeu de SERVICE — celui qu'un jeu présente pour lire les avoirs d'un
 * joueur. Ce n'est PAS le jeton d'identité : il ne circule jamais dans un
 * navigateur, il vit dans les variables d'environnement des deux côtés.
 *
 * ⚠️ Comparaison à durée constante : un secret comparé avec `===` fuit sa
 *    longueur puis son contenu, un caractère à la fois.
 */
export function memeSecret(a: string, b: string): boolean {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
