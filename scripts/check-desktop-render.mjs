const port = Number(process.env.PASS_DEBUG_PORT ?? 9339);
const deadline = Date.now() + 15_000;
let targets;

while (Date.now() < deadline) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) =>
      response.json(),
    );
    if (
      targets.some(
        (target) =>
          target.type === "page" && target.url?.toLowerCase().includes("index.html"),
      )
    ) {
      break;
    }
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const page = targets?.find(
  (target) =>
    target.type === "page" && target.url?.toLowerCase().includes("index.html"),
);
if (!page?.webSocketDebuggerUrl) {
  throw new Error("PASS desktop renderer was not available.");
}

await new Promise((resolve) => setTimeout(resolve, 2_000));

const result = await new Promise((resolve, reject) => {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const timer = setTimeout(
    () => reject(new Error("PASS desktop renderer check timed out.")),
    10_000,
  );

  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression:
            "JSON.stringify({title:document.title,heading:document.querySelector('h1')?.textContent,board:document.querySelector('[aria-label=\\\"8乘8足球棋盘\\\"]')?.childElementCount ?? 0,error:document.body.textContent?.includes('Application error')})",
          returnByValue: true,
        },
      }),
    );
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    socket.close();
    resolve(JSON.parse(message.result.result.value));
  });

  socket.addEventListener("error", () => {
    clearTimeout(timer);
    reject(new Error("Could not connect to PASS desktop renderer."));
  });
});

if (
  result.title !== "PASS" ||
  result.heading !== "PASS" ||
  result.board < 64 ||
  result.error
) {
  throw new Error(`Unexpected PASS desktop content: ${JSON.stringify(result)}`);
}

console.log(JSON.stringify(result));
