/** Demon Route: OpenAI-compatible gateway for open-weight, uncensored and roleplay fine-tunes. */
import type { ProviderSpoke } from "../spoke";
import { openAICompatModels } from "../models";

const BASE = "https://api.demonroute.com/v1";

const demonroute: ProviderSpoke = {
  id: "demonroute",
  label: "Demon Route",
  brand: "#E11D48",
  host: "api.demonroute.com",
  defaultModel: "TheDrummer/Cydonia-24B-v4.1",
  async model({ apiKey, baseURL, headers, model }, fetch) {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    return createOpenAICompatible({
      name: "demonroute",
      baseURL: baseURL ?? BASE,
      apiKey,
      headers,
      fetch,
    })(model);
  },
  async listModels({ apiKey, baseURL }, fetch) {
    return openAICompatModels(baseURL ?? BASE, apiKey, fetch);
  },
};

export default demonroute;
