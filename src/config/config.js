import dotenv from "dotenv";
dotenv.config();

/**
 * Config leída en cada acceso (no al import) — permite override
 * por env desde el CLI después del parseArgs.
 */
export const config = {
  get baseUrl() {
    return (
      process.env.BASE_URL ||
      "https://prod2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml"
    );
  },
  get headless() {
    return process.env.HEADLESS !== "false";
  },
};
