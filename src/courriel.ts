/**
 * ⭐⭐ L'ENVOI DE COURRIEL — par l'API HTTP de Brevo, pas par SMTP.
 *
 * 🔴 POURQUOI L'API ET PAS SMTP. Trois raisons, dans l'ordre :
 *
 *  1. **AUCUNE DÉPENDANCE.** Ce dépôt n'en a pas une seule : `package.json`
 *     n'a pas de champ `dependencies`, tout vient de `node:`. SMTP
 *     imposerait `nodemailer`, donc un `npm install` dans le Dockerfile,
 *     donc un arbre de dépendances à surveiller — pour envoyer un message
 *     de quinze lignes.
 *  2. **UN PORT SORTANT NE SE DEMANDE PAS À UN HÉBERGEUR.** Le 587 peut
 *     être fermé côté Coolify sans que personne l'ait décidé ; le 443 ne
 *     l'est jamais.
 *  3. **UNE ERREUR SMTP EST UN CODE À TROIS CHIFFRES.** Brevo rend un JSON
 *     qui nomme le problème (« expéditeur non vérifié », « clé invalide »),
 *     et c'est cette phrase qu'on veut dans le journal à 23 h.
 *
 * ⚠️ BREVO REND 201, PAS 200. Un contrôle `res.ok` suffit, mais un
 *    contrôle `res.status === 200` aurait déclaré en échec tous les envois
 *    réussis — et le service aurait redemandé un lien à l'infini.
 */

const CLE = () => process.env.BREVO_CLE ?? '';

/**
 * ⭐ Preda a choisi `noreply@`, en connaissance de cause. La contrepartie
 *    est réelle : le seul courriel que reçoive un nouvel inscrit est celui
 *    auquel il ne peut pas répondre. `BREVO_REPONSE_A` permet de rendre la
 *    réponse possible sans changer l'expéditeur — pose-la le jour où une
 *    boîte humaine existe.
 *
 * ⚠️ L'expéditeur DOIT être sur un domaine authentifié chez Brevo
 *    (`mail.veveprice.com` l'est : SPF dédié, DKIM par le domaine de
 *    marque, Return-Path chez Brevo). Une adresse hors de ce domaine est
 *    refusée par l'API — 400, pas silencieusement.
 */
export const expediteur = () => process.env.BREVO_EXPEDITEUR ?? 'noreply@mail.veveprice.com';
export const nomExpediteur = () => process.env.BREVO_NOM ?? 'VeVePrice';
const reponseA = () => process.env.BREVO_REPONSE_A ?? '';

/**
 * Le mode simulation. ⛔ IL NE S'ACTIVE PAS TOUT SEUL.
 *
 * 🔴 La tentation était d'écrire « si la clé est absente, on journalise le
 *    lien au lieu de l'envoyer » — pratique en développement. Ce serait un
 *    REPLI QUI OUVRE : le jour où la variable Coolify est mal orthographiée
 *    en production, le service continuerait de marcher, et chaque lien de
 *    connexion s'écrirait en clair dans un journal que plusieurs personnes
 *    peuvent lire. Une panne se répare ; une fuite silencieuse, non.
 *
 * Le repli doit donc être DEMANDÉ : `COURRIEL_SIMULE=1`. Sans clé et sans
 * cette variable, on échoue — franchement, et en le disant.
 */
const simule = () => process.env.COURRIEL_SIMULE === '1';

export interface Envoi { ok: boolean; id?: string; pourquoi?: string; simule?: boolean }

export interface Message { a: string; sujet: string; texte: string; html: string }

/**
 * 🔴 CETTE FONCTION NE LÈVE JAMAIS. Elle est appelée depuis une route HTTP
 *    qui doit répondre la MÊME chose que l'envoi ait réussi ou non (voir
 *    `server.ts`, route /inscription) : une exception qui remonterait
 *    changerait la page rendue, et cette différence dirait au visiteur si
 *    l'adresse existe déjà. On rend donc toujours un verdict.
 */
export async function envoyer(m: Message, fetchImpl: typeof fetch = fetch): Promise<Envoi> {
  if (simule()) {
    console.log(`[courriel] SIMULÉ → ${m.a} — « ${m.sujet} »`);
    console.log(`[courriel] SIMULÉ, corps :\n${m.texte}`);
    return { ok: true, simule: true };
  }
  if (!CLE()) return { ok: false, pourquoi: 'BREVO_CLE absente : aucun courriel ne peut partir' };

  try {
    const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': CLE(),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: nomExpediteur(), email: expediteur() },
        to: [{ email: m.a }],
        ...(reponseA() ? { replyTo: { email: reponseA() } } : {}),
        subject: m.sujet,
        textContent: m.texte,
        htmlContent: m.html,
      }),
      // ⚠️ Sans délai maximum, une API muette retient la requête HTTP du
      //    visiteur jusqu'au bout du timeout du système — soit deux
      //    minutes de page blanche.
      signal: AbortSignal.timeout(10_000),
    });
    const brut = await res.text();
    if (!res.ok) {
      // On garde la phrase de Brevo : c'est elle qui nomme le vrai défaut.
      return { ok: false, pourquoi: `Brevo ${res.status} : ${brut.slice(0, 300)}` };
    }
    let id: string | undefined;
    try { id = JSON.parse(brut)?.messageId; } catch { /* 201 sans corps lisible : ce n'est pas un échec */ }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, pourquoi: `Brevo injoignable : ${(e as Error).message}` };
  }
}

// ── Le courriel de connexion ───────────────────────────────────────────

/**
 * ⚠️ TEXTE **ET** HTML. Un message qui n'a que du HTML part avec un
 *    mauvais score de réputation, et certains clients n'affichent que le
 *    texte. Le lien doit être lisible et cliquable dans les deux.
 *
 * ⭐ Le lien apparaît EN CLAIR dans la version texte. C'est voulu : un
 *    client qui n'affiche pas le HTML laisserait sinon la personne devant
 *    un message sans porte.
 */
export function courrielDeConnexion(a: string, lien: string, minutes: number, nouveau: boolean): Message {
  const titre = nouveau ? 'Bienvenue — votre lien de connexion' : 'Votre lien de connexion';
  const texte = [
    nouveau ? 'Bienvenue sur VeVePrice.' : 'Vous avez demandé à vous connecter.',
    '',
    'Ouvrez ce lien pour entrer :',
    lien,
    '',
    `Il est valable ${minutes} minutes et ne fonctionne qu'une seule fois.`,
    '',
    "Si vous n'avez rien demandé, ignorez ce message : personne ne peut entrer sans ce lien.",
  ].join('\n');
  const html = `<!doctype html><html lang="fr"><meta charset="utf-8">
<body style="margin:0;padding:24px;background:#14161b;color:#e6e3dc;font:16px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:520px;margin:0 auto">
    <p style="margin:0 0 18px">${nouveau ? 'Bienvenue sur <b>VeVePrice</b>.' : 'Vous avez demandé à vous connecter.'}</p>
    <p style="margin:0 0 22px">
      <a href="${echapperAttribut(lien)}"
         style="display:inline-block;background:#c9a227;color:#1a1408;text-decoration:none;
                font-weight:600;padding:14px 22px;border-radius:10px">Entrer sur VeVePrice</a>
    </p>
    <p style="margin:0 0 8px;color:#9aa0ab;font-size:.9rem">
      Ce lien est valable ${minutes} minutes et ne fonctionne qu'une seule fois.</p>
    <p style="margin:0 0 18px;color:#9aa0ab;font-size:.9rem">
      Si le bouton ne fonctionne pas, copiez cette adresse :<br>
      <span style="word-break:break-all">${echapperAttribut(lien)}</span></p>
    <p style="margin:0;color:#9aa0ab;font-size:.9rem">
      Si vous n'avez rien demandé, ignorez ce message : personne ne peut entrer sans ce lien.</p>
  </div>
</body></html>`;
  return { a, sujet: titre, texte, html };
}

/**
 * ⚠️ Le lien est fabriqué par NOUS, mais il contient un jeton en base64url
 *    et une adresse lue dans une variable d'environnement. On échappe
 *    quand même : le jour où un paramètre viendra d'ailleurs, la protection
 *    sera déjà là plutôt qu'à écrire.
 */
const echapperAttribut = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
