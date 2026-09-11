# Ahorcado del Aula — Multijugador

Juego de ahorcado por equipos para el salón de clases. Una persona (la
maestra o el maestro) crea la sala y va poniendo palabra y pista en cada
ronda; los equipos entran desde su propio celular o computadora con un
código de 4 caracteres y tocan un "timbre" para ganar el turno de
responder. El sistema dibuja al muñeco solo, lleva el marcador y las
rondas de forma automática. Todo se sincroniza en vivo entre todas las
pantallas conectadas: no hace falta refrescar ni avisar en voz alta el
puntaje.

## Cómo está armado

- `server.js` — servidor Node.js (Express + Socket.io). Aquí vive toda la
  lógica del juego: salas, equipos, timbre, rondas y puntaje. La palabra
  real nunca se envía a los equipos, solo los espacios en blanco, así que
  no hay forma de "hacer trampa" viendo el código del navegador.
- `public/` — la página que ven maestro/a y equipos (HTML, CSS y JS,
  sin frameworks ni instalación en el navegador).
- `package.json` — dependencias (`express`, `socket.io`).

El estado de cada partida vive en la memoria del servidor. Eso significa
que si el servidor se reinicia, las salas activas se pierden — para una
clase esto es lo normal y evita depender de una base de datos externa.

## 1. Probarlo en tu computadora (Visual Studio Code)

1. Instala [Node.js](https://nodejs.org/) (versión 18 o más nueva) si no
   lo tienes.
2. Abre esta carpeta (`ahorcado-multijugador`) en Visual Studio Code.
3. Abre una terminal integrada (`Terminal → New Terminal`) e instala las
   dependencias:

   ```bash
   npm install
   ```

4. Arranca el servidor:

   ```bash
   npm start
   ```

5. Verás en la terminal `Ahorcado del Aula escuchando en el puerto 3000`.
   Abre `http://localhost:3000` en tu navegador — ahí entras como
   anfitrión/a.

### Para que tus alumnos entren desde el mismo salón (misma red Wi-Fi)

Mientras el servidor corre en tu laptop y todos están conectados a la
misma red:

1. Averigua la IP local de tu computadora:
   - Windows: `ipconfig` (busca "Dirección IPv4", algo como `192.168.1.23`)
   - Mac: `ipconfig getifaddr en0` (o revisa Preferencias del Sistema →
     Red)
2. Comparte con tus alumnos: `http://TU_IP:3000` (por ejemplo
   `http://192.168.1.23:3000`).
3. Ellos entran, eligen "Somos un equipo" y ponen el código de sala que
   tú generaste al crear la partida.

Esto funciona sin desplegar nada, siempre que tu laptop se quede
encendida y conectada durante la clase.

## 2. Publicarlo con un link fijo (para que funcione fuera del salón o sin depender de tu laptop)

Si quieres un link permanente que tus alumnos puedan abrir desde
cualquier lugar (o no quieres depender de que tu laptop esté prendida),
despliega el proyecto en un servicio con capa gratuita como
[Render](https://render.com) o [Railway](https://railway.app). Los pasos
son prácticamente iguales en ambos:

1. Sube esta carpeta a un repositorio de GitHub (puedes hacerlo desde
   Visual Studio Code: `Source Control → Publish to GitHub`).
2. En Render: `New +` → `Web Service` → conecta tu repositorio.
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - Deja el resto con los valores por defecto (detecta Node
     automáticamente).
3. Al terminar el despliegue te dan una URL pública, por ejemplo
   `https://ahorcado-del-aula.onrender.com`. Ese es el link que compartes
   con tus alumnos — todos entran ahí (tú como anfitrión/a, ellos como
   equipos) sin importar en qué red estén.

> Nota: en la capa gratuita de estos servicios el servidor puede
> "dormirse" tras varios minutos sin uso y tardar unos segundos en
> despertar con la primera visita del día — es normal, solo espera un
> momento antes de crear la sala.

## Cómo se juega

1. La maestra o el maestro abre el link, elige **"Soy la maestra / el
   maestro"**, define cuántas rondas se van a jugar y crea la sala. Se
   genera un código de 4 caracteres.
2. Cada equipo abre el mismo link en su dispositivo, elige **"Somos un
   equipo"**, escribe el código y el nombre de su equipo.
3. El anfitrión escribe la palabra (o frase) y la pista de la ronda —el
   campo está oculto por defecto para poder proyectarlo sin revelar la
   palabra— y elige la dificultad (número de intentos).
4. En cuanto empieza la ronda, cualquier equipo puede tocar el **timbre**
   en cuanto crea saber una letra o la palabra completa. El primero en
   tocarlo se queda con el turno (los demás ven que ya se adelantaron).
5. El equipo con el turno elige una letra del teclado, o arriesga la
   palabra completa para ganar más puntos. Si acierta, se revela en el
   tablero de todos y suma puntos; si falla, se dibuja una parte del
   ahorcado (compartido para todos) y el timbre se vuelve a abrir para
   que otro equipo lo intente. Si nadie responde en 15 segundos, el
   timbre también se libera solo.
6. La ronda termina cuando alguien completa la palabra (ronda ganada) o
   se acaban los intentos (nadie la adivinó). El anfitrión pasa a la
   siguiente ronda con un clic.
7. Al terminar todas las rondas se muestra el marcador final y el equipo
   (o equipos, en caso de empate) con más puntos.

### Puntaje

- Letra correcta: **+10 puntos**.
- Completar la palabra letra por letra: **+30 puntos extra** para el
  equipo que puso la última letra.
- Adivinar la palabra completa de un tiro: **+50 puntos**.
- Letra o palabra incorrecta: no resta puntos, pero avanza el dibujo del
  ahorcado (compartido por todos los equipos) y libera el timbre.

### Si un equipo pierde la conexión

Si a un equipo se le va el internet o recarga la página sin querer,
puede volver a entrar con el mismo código y el mismo nombre de equipo:
recupera su puntaje automáticamente (queda guardado en el servidor,
identificado por su dispositivo). Lo mismo aplica para el anfitrión: si
recarga su pantalla, retoma el control de la misma sala.

## Personalizar

Al inicio de `server.js` puedes ajustar:

```js
const POINTS_PER_LETTER = 10;
const ROUND_WIN_BONUS = 30;
const WORD_GUESS_BONUS = 50;
const BUZZ_TIMEOUT_MS = 15000; // milisegundos para responder tras tocar el timbre
```
