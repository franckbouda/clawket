# Model selection and catalog refresh

Owner request, 2026-10-16: repair model switching on both OpenClaw and Hermes and refresh available models automatically when opening the picker.

Catalog model IDs remain opaque. With a separate provider, OpenClaw writes `provider/native-model-id`, including IDs that contain a vendor namespace: provider `unsloth` and ID `unsloth/Qwen3.8-27B-GGUF` become `unsloth/unsloth/Qwen3.8-27B-GGUF`. Session reads that already supply `modelProvider` preserve the full native model ID. Hermes retains global selection within each native profile; OpenClaw retains its session/global scopes.

Opening the picker calls `models.list` with `refresh: true`. OpenClaw delegates discovery to the Gateway's authenticated provider catalog. An older Gateway may reject the additive field; only a specific field/schema rejection retries the legacy request. Provider, authorization and network errors remain visible. Discovery does not create providers or bypass configured model access policies.

Hermes bypasses the selected profile's Bridge model-state cache and asks its installed discovery API to refresh the current custom endpoint. Supported keyword arguments are detected so older installations keep working. Ordinary background reads keep their existing cache. Model switching accepts both legacy tuple parsers and the current structured native parser, without editing Hermes source or changing profile scope. Legacy `custom:name` references resolve to the configured native named provider when the installed catalog uses bare names.

Both Mobile and Bridge updates are needed for the complete behavior. A merge is distinct from local installation, package publication and deployment. Regression checks cover vendor namespaces, actual native Python parser shapes, catalog refresh and the legacy fallback boundary.
