import dotenv from "dotenv";
dotenv.config();

export const config = {
  baseUrl: process.env.BASE_URL || "https://prod2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml",
  headless: process.env.HEADLESS !== "false",
};
