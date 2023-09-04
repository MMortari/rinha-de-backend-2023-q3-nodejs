import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { URL } from "node:url";
import pg from "pg";

const port = 3333;
const cache_ttl = 5 * 60;

const redis = new Redis({
  port: "6379",
  host: process.env.REDIS_HOST ?? "localhost",
  pool: 100,
});

async function main() {
  const server = createServer();

  const pg_pool = new pg.Pool({
    host: process.env.DATABASE_HOST ?? "localhost",
    port: "5432",
    password: "postgres",
    user: "postgres",
  });

  console.log("Database connected");

  pg_pool.on("error", (err) =>
    console.error(`Error no pool do banco de dados`, err)
  );

  // await redis.connect();
  await validateDatabase(pg_pool);

  // await pg_pool.connect();

  // Listen to the request event
  server.on("request", async (request, res) => {
    const start = Date.now();

    const { method } = request;

    const { pathname: url, searchParams } = new URL(
      request.url,
      `http://127.0.0.1:3333`
    );

    const client = await pg_pool.connect();

    let response = {
      status: 404,
      payload: "Not found",
    };

    if (method === "GET") {
      if (url === "/") {
        response = { status: 200, payload: { message: "Hello" } };
      }
      if (url === "/pessoas") {
        response = await handleGetPersonQuery(client, searchParams.get("t"));
      }
      if (url === "/contagem-pessoas") {
        response = await handleGetPersonCount(client);
      }
      if (url.indexOf("/pessoas/") === 0) {
        const id = url.substring(9);
        const key = `pessoa:${id}`;

        const resp = await redis.get(key);

        if (resp) {
          response = {
            status: 200,
            payload: JSON.parse(resp),
          };
        } else {
          response = {
            status: 404,
            payload: "Not found",
          };
        }

        // const id = url.substring(9);

        // const key = `pessoa:${id}`;

        // const resp = await redis.get(key);

        // if (!resp) {
        //   response = await handleGetPersonByID(client, id);

        //   await redis.set(
        //     key,
        //     JSON.stringify(response.payload),
        //     "EX",
        //     cache_ttl
        //   );
        // } else {
        //   response = {
        //     status: 200,
        //     payload: JSON.parse(resp),
        //   };
        // }
      }
    }

    if (url === "/pessoas" && method === "POST") {
      response = await handleCreatePerson(client, await getBody(request));

      res.setHeader("Location", `/pessoas/${response.payload.id}`);
    }

    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(
      typeof response === "string" ? response : JSON.stringify(response.payload)
    );

    client.release();

    if (process.env?.LOG_DEBUG === "true") {
      console.log(
        `${method} ${url} ${response.status} - ${Date.now() - start}ms`
      );
    }
  });

  server.listen(port, () =>
    console.log(`server running process ${process.pid} at port`, port)
  );

  const exitSignals = ["SIGINT", "SIGTERM", "SIGQUIT"];

  exitSignals.forEach((sig) =>
    process.on(sig, async () => {
      console.log(`Signal received ${sig}`);
      try {
        await pg_pool.end();
        redis.disconnect();
        server.close();
        console.log(`Server exited with success`);
        process.exit(0);
      } catch (error) {
        console.log(`Server exited with error: ${error.stack}`, "", "error");
        process.exit(1);
      }
    })
  );
}

main();

async function handleGetPersonByID(client, id) {
  const { rows } = await client.query(`SELECT * FROM person WHERE id = $1;`, [
    id,
  ]);

  const [response] = rows;

  if (!response) {
    return {
      status: 404,
      payload: "Person not found",
    };
  }

  return {
    status: 200,
    payload: {
      id: response.id,
      apelido: response.apelido,
      nome: response.nome,
      nascimento: response.nascimento,
      stack: response.stack,
    },
  };
}
async function handleGetPersonQuery(client, query) {
  const { rows } = await client.query(
    `SELECT * FROM person WHERE query ILIKE '%${query}%';`
  );

  // const [response] = rows;

  if (!rows.length) {
    return {
      status: 200,
      payload: "Person not found",
    };
  }

  return {
    status: 200,
    payload: rows.map((item) => ({
      id: item.id,
      apelido: item.apelido,
      nome: item.nome,
      nascimento: item.nascimento,
      stack: item.stack,
    })),
  };
}
async function handleGetPersonCount(client) {
  const { rows } = await client.query(`SELECT count(1) as total FROM person;`);

  const [response] = rows;

  return {
    status: 200,
    payload: response,
  };
}
async function handleCreatePerson(client, data) {
  const { apelido, nome, nascimento, stack } = data;

  if (!apelido || !nome || !nascimento) {
    return {
      status: 422,
      payload: "Dados não enviados",
    };
  }

  if (stack && !Array.isArray(stack)) {
    return {
      status: 422,
      payload: "Dados incorretos",
    };
  }

  if (
    apelido.length > 32 ||
    nome.length > 100 ||
    typeof nome !== "string" ||
    stack?.some((item) => item.length > 32)
  ) {
    return {
      status: 422,
      payload: "Dados incorretos",
    };
  }

  const apelido_cache = await redis.get(`apelido:${apelido}`);

  if (apelido_cache) {
    return {
      status: 422,
      payload: "Pessoa já criada com o apelido",
    };
  }

  const id = randomUUID();

  const query = `${apelido}${nome}${
    stack ? (Array.isArray(stack) ? stack.join("") : stack) : ""
  }`;

  try {
    await client.query(
      `INSERT INTO person(id, apelido, nome, nascimento, stack, query) VALUES ($1, $2, $3, $4, $5, $6);`,
      [id, apelido, nome, nascimento, stack, query]
    );

    const payload = {
      id,
      apelido,
      nome,
      nascimento,
      stack,
    };

    await redis.set(`apelido:${apelido}`, true, "EX", cache_ttl);
    await redis.set(`pessoa:${id}`, JSON.stringify(payload), "EX", cache_ttl);

    return {
      status: 201,
      payload: payload,
    };
  } catch (err) {
    console.log(stack);
    console.log(err);

    return {
      status: 500,
      payload: "Erro ao criar pessoa",
    };
  }
}

async function getBody(request) {
  return new Promise((res, rej) => {
    let body = [];
    request
      .on("data", (chunk) => {
        body.push(chunk);
      })
      .on("end", () => {
        res(JSON.parse(Buffer.concat(body).toString()));
      })
      .on("error", () => rej(null));
  });
}

async function validateDatabase(pool) {
  const { rows } = await pool.query(
    `SELECT * FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person'`
  );

  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  if (!rows.length) {
    await pool.query(
      `CREATE TABLE person (
        id uuid PRIMARY KEY,
        apelido varchar(32) NOT NULL UNIQUE,
        nome varchar(100) NOT NULL,
        nascimento varchar(20) NOT NULL,
        query varchar(510),
        stack varchar(32)[]
      );`
    );
    await pool.query(
      `CREATE INDEX idx_query ON person USING gist (query gist_trgm_ops);`
    );
    console.log("Database created");
  }
}
