# Milo Proxy

Service installé sur le réseau d'un site, qui relaie vers ses périphériques
(imprimantes Zebra pour commencer) les requêtes de Milo, hébergé sur Internet
et qui ne peut pas les joindre.

Le proxy ouvre **une** connexion WebSocket sortante, sur HTTPS, vers
`wss://<milo>/api/proxy/socket` ; Milo n'ouvre jamais de connexion vers lui.
Aucun port à ouvrir en entrée sur le site. Le protocole est décrit dans le
dépôt Milo : `ressources/proxy/PROTOCOL.md`.

Ce que le proxy s'impose, quoi que Milo demande :

- il ne joint que les périphériques de la dernière liste reçue de Milo, par
  leur identifiant (une requête ne contient jamais d'adresse) ;
- chaque service a son port dans le code (`src/requests.ts`) :
  `raw-print` = TCP 9100 ; aucune requête ne choisit un port ;
- seules les opérations `send` et `exchange` existent.

## Prérequis

- Linux avec systemd (≥ 247, Ubuntu 22.04 ou plus récent) ;
- Node.js 20 ou plus récent, en `/usr/bin/node` ;
- un accès HTTPS sortant vers Milo, et TCP 9100 vers les imprimantes.

## Installation

1. Dans Milo, **Paramétrage > Proxy** : ajouter le proxy. Milo affiche une
   seule fois les lignes de configuration (`server=…`, `token=…`).
2. Sur la machine du site :

   ```sh
   sudo mkdir -p /opt/milo-proxy
   sudo cp dist/milo-proxy.mjs /opt/milo-proxy/
   sudo cp deploy/milo-proxy.service /etc/systemd/system/

   # Les lignes données par Milo :
   sudo install -m 600 -o root -g root /dev/null /etc/milo.proxy.conf
   sudo nano /etc/milo.proxy.conf

   sudo systemctl daemon-reload
   sudo systemctl enable --now milo-proxy
   ```

3. Dans Milo, le proxy apparaît connecté ; rattacher les imprimantes du site
   à ce proxy (**Paramétrage > Impression**).

Seul `dist/milo-proxy.mjs` est déployé : `ws` y est inclus, pas de
`npm install` sur la machine.

## Exploitation

```sh
systemctl status milo-proxy
journalctl -u milo-proxy -f
```

- **Token régénéré** dans Milo : remplacer la ligne `token=` puis
  `sudo systemctl restart milo-proxy`. L'ancien token est refusé aussitôt.
- **Reconnexion** : après une coupure, de 1 s à 1 min (délai doublé à chaque
  échec). Token refusé, proxy supprimé, protocole refusé ou trop d'échecs :
  nouvelle tentative toutes les 10 min seulement. Connexion remplacée par une
  autre (même token sur deux machines ?) : 1 min.
- **Configuration invalide** : le service s'arrête (code 78) sans redémarrer
  en boucle ; le journal dit pourquoi.

## Développement

```sh
npm install
npm run typecheck
npm test          # faux Milo et fausse imprimante en local
npm run build     # dist/milo-proxy.mjs
```

Contre un Milo de développement, `server=` accepte une adresse complète :

```sh
printf 'server=http://localhost:3001\ntoken=mpx_…\n' > local.conf
MILO_PROXY_CONFIG=./local.conf npm start
```

La configuration est lue, dans l'ordre : `$CREDENTIALS_DIRECTORY/config`
(systemd), `$MILO_PROXY_CONFIG`, `/etc/milo.proxy.conf`.

Le protocole parlé est `PROTOCOL` (`src/proxy.ts`), qui doit égaler
`PROXY_PROTOCOL` de Milo (`shared/src/proxies.ts`).
