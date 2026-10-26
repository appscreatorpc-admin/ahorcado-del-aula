# Ahorcado del Aula — Multijugador

Juego de ahorcado por equipos para el salón de clases. La maestra o el
maestro prepara de una vez la palabra y la pista de cada ronda; los
equipos entran desde su propio celular o computadora con un código de 4
caracteres y tocan un "timbre" para ganar el turno de responder. El
sistema dibuja al muñeco solo, lleva el marcador y las rondas de forma
automática, y todo se sincroniza en vivo entre todas las pantallas
conectadas.

## Qué cambió en esta versión

A partir de lo que se detectó usándolo en clase:

- **Los equipos se identifican por nombre, no por dispositivo.** Si dos
  alumnos del mismo equipo entran cada uno desde su celular escribiendo
  el mismo nombre de equipo, comparten un solo marcador (antes cada
  celular creaba un equipo aparte con 0 puntos, por eso parecía que los
  puntos "no se acumulaban"). El nombre no distingue mayúsculas, acentos
  ni espacios de más, así que "Los Tigres", "los tigres" y "LOS TIGRES "
  son el mismo equipo.
- **El equipo con el timbre conserva el turno mientras siga acertando.**
  Antes se liberaba el timbre después de cada letra, acertada o no.
  Ahora solo se libera cuando el equipo se equivoca — así pueden resolver
  varias letras seguidas si van bien.
- **Adivinar la palabra completa** sigue disponible para el equipo que
  tiene el turno (no solo letra por letra): si acierta, gana la ronda de
  inmediato con un bono mayor; si falla, no se revela nada extra, pero
  sí cuenta como un intento fallido (igual que fallar una letra) y
  libera el timbre.
- **Si se agotan los intentos sin que nadie complete la palabra**, gana
  la ronda el equipo que haya acertado más letras durante esa ronda (en
  vez de que nadie gane). Si nadie acertó ninguna letra, la ronda queda
  sin ganador.
- **El anfitrión controla el timbre por completo:** además de poder
  liberar al equipo que lo esté deteniendo, ahora puede **cerrar el
  timbre** por completo (para que nadie pueda tocarlo mientras explica
  algo o mientras prepara la siguiente ronda) y **abrirlo** cuando esté
  listo.
- **Todas las palabras se preparan desde el inicio.** Al crear la sala,
  el anfitrión escribe de una vez la palabra, la pista y la dificultad de
  cada ronda (si elige 3 rondas, llena 3 tarjetas). Esas palabras nunca
  se envían a los equipos por adelantado — solo llegan al anfitrión,
  ronda por ronda, en el momento de empezarlas. Aun así, el campo de la
  ronda en turno sigue siendo editable por si se quiere cambiar algo de
  último momento.
- **Desglose final:** al terminar el juego, además del marcador final,
  se muestra ronda por ronda qué palabra tocó, quién la ganó y por qué
  (completó la palabra letra por letra, adivinó la palabra completa, ganó
  por tener más aciertos, o nadie acertó).

## Cómo está armado

- `server.js` — servidor Node.js (Express + Socket.io). Aquí vive toda
  la lógica del juego: salas, equipos, timbre, rondas y puntaje. La
  palabra real nunca se envía a los equipos, solo los espacios en
  blanco, así que no hay forma de "hacer trampa" viendo el código del
  navegador. Las palabras de las rondas que aún no empiezan tampoco se
  transmiten nunca a nadie — ni al propio anfitrión hasta que las pide.
- `public/` — la página que ven maestro/a y equipos (HTML, CSS y JS, sin
  frameworks ni instalación en el navegador).
- `package.json` — dependencias (`express`, `socket.io`).

El estado de cada partida vive en la memoria del servidor. Si el
servidor se reinicia, las salas activas se pierden — para una clase esto
es lo normal y evita depender de una base de datos externa.

## 1. Probarlo en tu computadora (Visual Studio Code)

1. Instala [Node.js](https://nodejs.org/) (versión 18 o más nueva) si no
   lo tienes.
2. Abre esta carpeta (`ahorcado-multijugador`) en Visual Studio Code.
3. Abre una terminal integrada e instala las dependencias:

   ```bash
   npm install
   ```

4. Arranca el servidor:

   ```bash
   npm start
   ```

5. Abre `http://localhost:3000` en tu navegador.

### Para que tus alumnos entren desde el mismo salón (misma red Wi-Fi)

1. Averigua la IP local de tu computadora (`ipconfig` en Windows,
   `ipconfig getifaddr en0` en Mac).
2. Comparte `http://TU_IP:3000` con tus alumnos.

## 2. Actualizar tu versión ya publicada en Render

Si ya habías desplegado una versión anterior de este proyecto en Render
siguiendo la guía que te pasé, actualizarla es sencillo — **no necesitas
crear un servicio nuevo**:

1. Entra a tu repositorio en GitHub (el mismo que ya conectaste a
   Render).
2. Para cada archivo que cambió (`server.js`, `public/index.html`,
   `public/style.css`, `public/client.js`), ábrelo en GitHub, da clic al
   ícono de lápiz (editar) y reemplaza todo el contenido por el de la
   nueva versión que te compartí — o bórralo y vuelve a subirlo con
   "Add file → Upload files" (GitHub te preguntará si quieres
   reemplazar el existente; di que sí).
3. Da "Commit changes" en cada archivo.
4. Render detecta el cambio en GitHub automáticamente y vuelve a
   desplegar el servicio solo, en un par de minutos — no hay que tocar
   nada en Render.

Si prefieres hacerlo de un solo golpe: borra la carpeta `public` y los
archivos `server.js`, `package.json` de tu repositorio, y vuelve a
subir el contenido completo de esta carpeta con "Add file → Upload
files" (asegurándote, como la primera vez, de que `public/` quede como
carpeta y no como archivos sueltos en la raíz).

## Cómo se juega

1. La maestra o el maestro abre el link, elige **"Soy la maestra / el
   maestro"**, escribe cuántas rondas quiere y llena una tarjeta por
   cada ronda (palabra, pista y dificultad). Al terminar, crea la sala y
   recibe un código de 4 caracteres.
2. Cada equipo abre el mismo link, elige **"Somos un equipo"**, escribe
   el código y el nombre de su equipo. Si varios integrantes entran cada
   uno desde su celular, todos deben escribir el mismo nombre de equipo
   para compartir el marcador.
3. El anfitrión ve la palabra de la ronda ya prellenada (puede editarla
   si quiere) y da clic en "Comenzar ronda".
4. Cualquier equipo puede tocar el **timbre** en cuanto crea saber una
   letra o la palabra completa. El primero en tocarlo se queda con el
   turno.
5. El equipo con el turno elige una letra, o arriesga la palabra
   completa. Si acierta una letra, **conserva el turno** y puede seguir
   intentando; si falla (letra o palabra), se dibuja una parte del
   ahorcado y el timbre se libera para que otro equipo lo intente. Si
   nadie responde en 15 segundos, el timbre también se libera solo.
6. El anfitrión puede cerrar el timbre en cualquier momento (por
   ejemplo, mientras explica algo) con el botón "Cerrar timbre", y
   reabrirlo cuando esté listo con "Abrir timbre". También puede
   "Liberar al equipo actual" si quiere quitarle el turno a alguien sin
   cerrar el timbre por completo.
7. La ronda termina cuando alguien completa la palabra (gana quien la
   completó) o se acaban los intentos (gana quien haya acertado más
   letras en esa ronda; si nadie acertó ninguna, la ronda queda sin
   ganador). El anfitrión pasa a la siguiente ronda —ya con la palabra
   siguiente prellenada— con un clic.
8. Al terminar todas las rondas se muestra el marcador final **y el
   desglose de cada ronda**: qué palabra tocó, quién la ganó y por qué.

### Puntaje

- Letra correcta: **+10 puntos** (se pueden encadenar varias mientras no
  falles).
- Completar la palabra letra por letra: **+30 puntos extra** para el
  equipo que puso la última letra.
- Adivinar la palabra completa de un tiro: **+50 puntos**.
- Ganar la ronda por tener más aciertos cuando se agotan los intentos
  (nadie completó la palabra): **+15 puntos**.
- Letra o palabra incorrecta: no resta puntos, pero cuesta un intento
  (avanza el dibujo del ahorcado, compartido por todos los equipos) y
  libera el timbre.

### Si un equipo pierde la conexión

Si a un equipo se le va el internet o recarga la página, puede volver a
entrar con el mismo código y el mismo nombre de equipo: recupera su
puntaje automáticamente. Lo mismo aplica para el anfitrión: si recarga
su pantalla, retoma el control de la misma sala y sigue viendo la
palabra de la ronda en turno.

## Personalizar

Al inicio de `server.js` puedes ajustar:

```js
const POINTS_PER_LETTER = 10;
const ROUND_WIN_BONUS = 30;
const WORD_GUESS_BONUS = 50;
const MOST_CORRECT_BONUS = 15;
const BUZZ_TIMEOUT_MS = 15000; // milisegundos para responder tras tocar el timbre
```
