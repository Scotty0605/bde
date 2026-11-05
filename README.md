# BDE — Organisation des pôles

Site de gestion des tâches du bureau, avec un accès cloisonné par pôle.

- **Présidence** (Président, Vice-président) : voit et modifie tout, gère les comptes.
- **Vue d'ensemble** (Secrétaire général) : voit tous les pôles, en lecture seule.
- **Responsable d'un pôle** : crée, modifie et **coche** les tâches de son pôle uniquement.
- **Membre** : suit un pôle en lecture seule (inscription libre, sauf Présidence et Trésorerie).

Chaque tâche cochée affiche **qui l'a cochée, le jour et l'heure**. Ces informations sont écrites
par la base de données elle-même : impossible de les falsifier depuis le site. Un historique complet
(création, coche, décoche, modification, suppression) est consultable sur chaque tâche.

La sécurité est appliquée **par la base** (règles RLS de Supabase), pas seulement par l'affichage :
même en bricolant le code dans son navigateur, un responsable com ne peut ni lire ni modifier la trésorerie.

---

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Page du site |
| `app.js` | Toute la logique (connexion, pôles, tâches, événements, administration) |
| `style.css` | Apparence (mode clair / sombre automatique, adapté au téléphone) |
| `config.js` | **À remplir** : URL et clé publique de ton projet Supabase |
| `supabase/schema.sql` | Tables + règles de sécurité, à exécuter une fois dans Supabase |

Aucune étape de build : ce sont des fichiers statiques, hébergeables tels quels.

---

## Mise en place

### 1. Supabase

1. Crée un projet sur [supabase.com](https://supabase.com).
2. **SQL Editor → New query** : colle tout le contenu de `supabase/schema.sql`, puis **Run**.
3. **Project Settings → API** : copie la *Project URL* et la clé *anon / publishable*
   dans `config.js`. Change aussi `NOM_BDE` si tu veux.
   > Ne mets jamais la clé `service_role` / `secret` dans le site.
4. **Authentication → URL Configuration** :
   - *Site URL* : l'adresse finale du site (ex. `https://ton-pseudo.github.io/bde/`).
   - *Redirect URLs* : ajoute la même adresse (et `http://localhost:5500` si tu testes en local).
   Sans ça, les liens de confirmation et de mot de passe oublié ne ramènent pas sur le site.
5. **Authentication → Providers → Email** : laisse « Confirm email » activé (recommandé).

### 2. Hébergement (GitHub Pages, Vercel ou Netlify)

Pousse le dossier sur GitHub, puis active GitHub Pages (Settings → Pages → branche `main`, dossier `/`),
ou importe le dépôt sur Vercel / Netlify sans configuration particulière.

### 3. Te nommer président

1. Inscris-toi sur le site.
2. Dans Supabase **SQL Editor**, lance (avec ton e-mail) :

   ```sql
   update public.profiles
      set global_role = 'admin', title = 'Président'
    where id = (select id from auth.users where email = 'ton.email@exemple.fr');
   ```

3. Recharge le site : le menu **Administration** apparaît.

### 4. Inviter le bureau

Envoie le lien au bureau. Une fois inscrits, dans **Administration** :

| Personne | Accès global | Pôle(s) |
|---|---|---|
| Président, 2 vice-présidents | Présidence (tout) | — |
| Secrétaire(s) | Vue d'ensemble (lecture) si tu veux qu'ils voient tout, sinon Accès par pôle | Secrétariat → Responsable |
| Trésorier, vice-trésorier | Accès par pôle | Trésorerie → Responsable |
| Respo com, respo TikTok | Accès par pôle | Communication → Responsable |
| Respo logistique | Accès par pôle | Logistique → Responsable |
| Respo sponsors | Accès par pôle | Sponsors → Responsable |
| Respo animation | Accès par pôle | Animation → Responsable |
| Respo(s) prépa | Accès par pôle | Prépa → Responsable |
| Relations internationales | Accès par pôle | Relations internationales → Responsable |
| Personnes qui aident dans un pôle | Accès par pôle | Le pôle → Membre (lecture) |

Un pôle peut avoir plusieurs responsables : chacun peut cocher, et le site affiche qui l'a fait.
La présidence peut ajouter quelqu'un comme membre même dans un pôle fermé (ex. Trésorerie).

Les pôles (noms, couleurs, ordre, inscription libre) se modifient aussi depuis **Administration**.

---

## Bon à savoir

- **Temps réel** : quand quelqu'un coche une tâche, les autres écrans se mettent à jour tout seuls.
- **Événements** : un événement (gala, WEI…) regroupe les tâches de plusieurs pôles. Chacun n'y voit
  que les tâches des pôles auxquels il a accès.
- **Garde-fou** : impossible de retirer le dernier administrateur.
- **Noms visibles** : tout compte connecté voit les noms des autres membres (nécessaire pour afficher
  « fait par… »). Les e-mails ne sont visibles que par la présidence.
- Le script `schema.sql` peut être relancé sans casser les données existantes.

## Pistes pour la suite

- Vue calendrier des échéances
- Rappels par e-mail des tâches en retard
- Commentaires sur les tâches
- Pièces jointes (devis, factures) via Supabase Storage, avec les mêmes droits par pôle
