import dotenv from "dotenv";
dotenv.config();

export const config = {
  baseUrl: process.env.BASE_URL,
  headless: process.env.HEADLESS === "true"
};