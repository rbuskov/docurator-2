const DEFAULT_PORT = 3737

const port = process.env.APP_PORT !== undefined ? Number(process.env.APP_PORT) : DEFAULT_PORT

export const config = Object.freeze({
  port,
})
