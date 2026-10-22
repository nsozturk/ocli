# Vendored plugin parity (A2)

One row per vendored CodexBar plugin (commit `6480977`); all 70 load in `plugin-host.mjs` and their manifests parse
(`tests/usage-readers-plugins-load.test.ts`). This table drives the fixture batches A4+.

- **Auth / Capabilities / Cookie domains**: as each plugin's `defineProvider({...})` declares them.
- **Host features still needed**: from a source scan for `ctx.storage`, a `persist:` result key, a `card:` result key,
  `costUsage`, and other host options this port does not implement yet. Retry policy, `getWithOptional` and
  private-network HTTP are implemented (A2) and not listed. A3 implemented persist (Fireworks `ACCOUNT_SLUG`, the only
  grant CodexBar's descriptors make), persistent storage, costUsage, the OpenAI history card and OpenRouter management
  auth; the cells say so. Still open: OpenAI's `card.openAIAPIUsage.live` throughput (CodexBar maps it with `try?`, so
  ignoring it never fails a reading).
- **CodexBar tests**: files in `Tests/CodexBarTests/` whose name carries the provider name (case-insensitive;
  prefix-only for short names such as Exa, Fal, Poe, V0, Zed, Zai, Nous, Hyper, Muse, XAI so unrelated words are not
  matched). Fixtures for several API-balance plugins may also live in shared files such as `APIBalancePluginTests.swift`,
  which this column does not attribute. "none" = no file carries the name.

| File | Provider id | Auth | Capabilities | Cookie domains | Host features still needed | CodexBar tests |
|---|---|---|---|---|---|---|
| abacus.js | abacus | none | browser-cookies, http-status | apps.abacus.ai | — | AbacusMonthlyPercentTests, AbacusProviderTests, AbacusQuotaPresentationTests, AbacusSnapshotFixture |
| aerostack.js | aerostack | bearer | http-status | — | — | AerostackPluginTests |
| aiand.js | aiand | bearer | http-status | — | — | AiAndProviderTests |
| aixy.js | aixy | bearer | http-status | — | — | none |
| atlascloud.js | atlascloud | bearer | http-status | — | — | none |
| bifrost.js | bifrost | header (x-bf-vk) | http-status | — | — | BifrostPluginTests, BifrostPresentationTests, BifrostRateLimitPluginTests, BifrostSettingsTests |
| chutes.js | chutes | bearer | http-status | — | — | ChutesPresentationTests, ChutesProviderTests |
| claudeplatform.js | claudeplatform | none | browser-cookies, http-status | platform.claude.com | — | none |
| clawrouter.js | clawrouter | bearer | — | — | — | ClawRouterUsageFetcherTests |
| clinepass.js | clinepass | bearer | — | — | — | ClinePassMultiAccountTests, ClinePassPluginTests, ClinePassProviderTests, ClinePassSettingsReaderTests |
| cosmic.js | cosmic | bearer | http-status | — | — | CosmicPluginTests |
| deepgram.js | deepgram | authorization-scheme (Token) | — | — | — | DeepgramProviderTests |
| deepinfra.js | deepinfra | bearer | http-status | — | — | DeepInfraMenuBarMetricWindowResolverTests, DeepInfraPluginTests, DeepInfraSettingsReaderTests |
| devpass.js | devpass | bearer | http-status | — | — | DevPassPluginTests, DevPassScreenshotRenderTests |
| elevenlabs.js | elevenlabs | header (xi-api-key) | — | — | — | ElevenLabsProviderTests |
| exa.js | exa | x-api-key | http-status | — | — | ExaPluginTests |
| fal.js | fal | authorization-scheme (Key) | http-status | — | — | FalPluginTests |
| fireworks.js | fireworks | bearer | — | — | — (A3: persist ACCOUNT_SLUG) | FireworksSettingsReaderTests, FireworksUsageFetcherTests |
| flora.js | flora | bearer | http-status | — | — | FloraPluginTests |
| futureagi.js | futureagi | x-api-key | http-status | — | — | FutureAGIPluginTests |
| gemini-web.js | gemini | none | browser-cookies, http-status | gemini.google.com, google.com | — | GeminiWebSourceTests (the other Gemini* files test CodexBar's native Gemini CLI/API provider) |
| gitkraken.js | gitkraken | bearer | http-status | — | — | none |
| helmcode.js | helmcode | none | browser-cookies, http-status | helmcode.com, cloud-api.helmcode.com, nan.builders | — | HelmcodeCookieCompatibilityTests, HelmcodePluginTests, HelmcodeProviderSettingsTests, HelmcodeScreenshotRenderTests |
| huggingface.js | huggingface | none | browser-cookies, http-status | huggingface.co | — | HuggingFacePluginTests, HuggingFaceScreenshotRenderTests, HuggingFaceSettingsReaderTests, HuggingFaceWalletPluginTests |
| hyper.js | hyper | none | browser-cookies, http-status | hyper.charm.land | — | HyperPresentationTests |
| langdock.js | langdock | none | browser-cookies, http-status | langdock.com, app.langdock.com | — | LangdockBrowserProfileTests, LangdockHistoryTests, LangdockPluginTests, LangdockProfileScreenshotTests, LangdockScreenshotRenderTests, LangdockUsageTests |
| linkup.js | linkup | bearer | http-status | — | — | LinkupPluginTests |
| litellm.js | litellm | bearer | http-status | — | — | LiteLLMMenuCardModelTests, LiteLLMModelUsageTests, LiteLLMPluginTestSupport, LiteLLMQuotaPresentationTests, LiteLLMSpendReportTests, LiteLLMUsageFetcherTests |
| lithosai.js | lithosai | none | browser-cookies, http-status | console.lithosai.cloud | — | none |
| llmman.js | llmman | none | http-status | — | — | LLMManPluginTests, LLMManScreenshotRenderTests, LLMManSettingsReaderTests |
| llmproxy.js | llmproxy | bearer | http-status | — | — | LLMProxyUsageFetcherTests |
| longcat.js | longcat | none | browser-cookies, http-status | longcat.chat, www.longcat.chat | — | LongCatCLISettingsTests, LongCatProviderTests, LongCatQuotaPresentationTests |
| manus.js | manus | none | browser-cookies, http-status | manus.im | — | ManusCookieHeaderTests, ManusPluginTests, ManusProviderTests, ManusReference |
| moonshot.js | moonshot | bearer | http-status | — | — | MoonshotCurrencyNativeProofTests, MoonshotSettingsReaderTests |
| munito.js | munito | bearer | http-status | — | — | none |
| muse.js | muse | none | browser-cookies, http-status | dev.meta.ai | — | MuseCredentialsTests, MuseKeychainAccessTests, MuseMenuCardModelTests, MusePluginTests, MuseScreenshotRenderTests, MuseSettingsDescriptorTests, MuseTokenHistoryPresentationTests |
| museai.js | museai | none | browser-cookies, http-status, persistent-storage | muse.ai | — (A3: storage) | none |
| neuralwatt.js | neuralwatt | bearer | http-status | — | — | MenuCardNeuralWattTests, NeuralWattPluginTestSupport, UsageStoreNeuralWattAccountRefreshTests |
| notion.js | notion | none | browser-cookies, http-status | app.notion.com, www.notion.com, notion.com, www.notion.so, notion.so | — | NotionMenuCardModelTests, NotionProviderTests |
| nous.js | nous | bearer | http-status | — | — | NousPluginTests, NousScreenshotRenderTests, NousSettingsReaderTests |
| ollama-api.js | ollama | bearer | http-status | — | — | OllamaAPIBalanceProofTests, OllamaAPIBalanceTests (the other Ollama* files test CodexBar's native Ollama provider) |
| openai.js | openai | bearer | — | — | card `live` throughput (A3 maps the history card only) | OpenAIAPIMenuCardModelTests, OpenAIAPIProjectScopeTests, OpenAIAPIStatusMenuTests, OpenAIAPIUsageFetcherTests |
| openrouter.js | openrouter | bearer | — | — | — (A3: costUsage + openRouterManagementAuth) | OpenRouterCredentialStrategyTests, OpenRouterCreditsFallbackNativeProofTests, OpenRouterDiagnosticTests, OpenRouterLimitTestSupport, OpenRouterManagementActivityTests, OpenRouterMultiAccountTests, OpenRouterNativeProofTests, OpenRouterPinnedLoopbackTransport, OpenRouterProviderDescriptorTests, OpenRouterReasoningTestSupport, OpenRouterReasoningTests, OpenRouterSharingTests, OpenRouterTestSnapshots, OpenRouterUsageStatsTests |
| parallel.js | parallel | none | browser-cookies, http-status | platform.parallel.ai | — | ParallelPluginTests |
| perplexity.js | perplexity | none | browser-cookies, http-status | www.perplexity.ai | — | CookieReferencePerplexityModels, CookieReferencePerplexityUsageSnapshot, PerplexityCookieCacheTests, PerplexityCookieHeaderTests, PerplexityCreditPercentTests, PerplexityPromoExpiryLocaleTests, PerplexityProviderTests, PerplexitySettingsReaderTests, PerplexityUsageFetcherTests |
| poe.js | poe | bearer | — | — | — | PoeProviderDescriptorTests, PoeSettingsReaderTests, PoeUsageFetcherTests |
| qoder.js | qoder | none | browser-cookies, http-status | qoder.com, qoder.com.cn | — | CookieReferenceQoderUsageSnapshot, QoderDashboardActionTests, QoderProviderBehaviorTests, QoderProviderTests, QoderReferenceParser, QoderUsageFetcherTests |
| qwencloud-team.js | qwencloud | none | browser-cookies, http-status | home.qwencloud.com | — | QwenCloudProviderTests, QwenCloudTeamMenuTests |
| raycast.js | raycast | none | browser-cookies, http-status | raycast.com, www.raycast.com | — | RaycastMenuCardModelTests, RaycastScreenshotRenderTests |
| replicate.js | replicate | none | browser-cookies, http-status | replicate.com | — | ReplicateCookieStrategyTests, ReplicatePluginTests, ReplicateScreenshotRenderTests |
| sailresearch.js | sailresearch | bearer | http-status | — | — | SailResearchPluginTests |
| sakana.js | sakana | header (Cookie) | http-status | — | — | MenuDescriptorSakanaTests |
| sofya.js | sofya | bearer | http-status | — | — | SofyaPluginTests |
| sub2api.js | sub2api | bearer | — | — | — | MenuDescriptorSub2APITests, Sub2APICLIOutputTests, Sub2APIMenuCardModelTests, Sub2APIPluginGoldenTests, Sub2APIUsageFetcherTests |
| synthetic.js | synthetic | bearer | — | — | — | SyntheticMenuCardTests, SyntheticProviderTests |
| t3chat.js | t3chat | none | browser-cookies, http-status | t3.chat | — | T3ChatPluginTests, T3ChatReference, T3ChatUsageFetcherTests |
| tavily.js | tavily | bearer | http-status | — | — | TavilyPluginTests |
| tinyapi.js | tinyapi | none | browser-cookies, http-status | tinyapi.rest | — | TinyApiPluginTests |
| typesafe.js | typesafe | none | browser-cookies, http-status | console.typesafe.ai, typesafe.ai | — | TypeSafeCookieStrategyTests, TypeSafePluginTests, TypeSafeRedirectTests, TypeSafeScreenshotRenderTests |
| v0.js | v0 | bearer | http-status | — | — | V0ScreenshotRenderTests |
| venice.js | venice | bearer | — | — | — | VeniceBrowserOrderTests, VeniceClerkSessionTests, VenicePresentationTests, VeniceSettingsReaderTests, VeniceUsageFetcherTests, VeniceUsageSourceTests, VeniceWebUsageFetcherTests |
| vercel.js | vercel | bearer | http-status | — | — | none |
| workbuddy.js | workbuddy | none | browser-cookies, http-status | workbuddy.cn, www.workbuddy.cn | — | WorkBuddyLocalizationTests, WorkBuddyScreenshotRenderTests |
| xai.js | xai | bearer | — | — | — | XAICostUsageMappingTests, XAIProviderTests |
| xapi.js | xapi | none | browser-cookies, http-status | x.com, console.x.com | — | XAPISettingsTests |
| xkiro.js | xkiro | bearer | http-status | — | — | XKiroPluginTests |
| zai.js | zai | bearer | — | — | — | ZaiAvailabilityTests, ZaiMenuCardTests, ZaiProviderTests, ZaiTokenAccountEnvironmentTests, ZaiTokenStoreTestSupport |
| zed.js | zed | none | browser-cookies, http-status | zed.dev | — | ZedPluginTests, ZedStatusProbeTests |
| zenmux.js | zenmux | bearer | http-status | — | — | ZenMuxPluginTests, ZenMuxProviderTests |
| zoommate.js | zoommate | none | browser-cookies, http-status | zoom.us, ai.zoom.us, zoommate.zoom.us | — | ZoomMateProviderTests |

Totals: 70 plugins; storage 1 (museai), persist 1 (fireworks), card 1 (openai), costUsage 1 (openrouter).

Note — `openRouterManagementAuth`: CodexBar lets only OpenRouter's GET `https://openrouter.ai/api/v1/activity` swap the
manifest auth secret for `OPENROUTER_MANAGEMENT_API_KEY` (ProviderPluginManifest.swift `openRouterManagementAuthSecret`).
The A2 host ignores the option, so that one request would carry the regular `OPENROUTER_API_KEY`. Not in A2's scope;
it belongs with the OpenRouter fixture batch.
