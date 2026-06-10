import uuid
from eudora.extras.langchain import EudoraCallbackHandler
from langchain_core.outputs import LLMResult, Generation

handler = EudoraCallbackHandler(
    proxy_key="eudora-proxy-svrAUA5F62q1m0S2nGahfuedsniQQCMW",
    agent_id="WddJn8R9DRPyRAJ_Gd06T",
    eudora_base_url="http://localhost:3001"
)

print("--- Test 1: normal interaction ---")
run_id = uuid.uuid4()
handler.on_llm_start({"name": "qwen3-coder:30b"}, ["What is DORA compliance?"], run_id=run_id)
result = LLMResult(generations=[[Generation(text="DORA is the Digital Operational Resilience Act...")]])
handler.on_llm_end(result, run_id=run_id)
print("✓ completed without error")

print("\n--- Test 2: DLP trigger (AWS key in prompt) ---")
run_id2 = uuid.uuid4()
handler.on_llm_start({"name": "qwen3-coder:30b"}, ["My AWS key is AKIAIOSFODNN7EXAMPLE"], run_id=run_id2)
result2 = LLMResult(generations=[[Generation(text="I can help with that.")]])
handler.on_llm_end(result2, run_id=run_id2)
print("✓ DLP test completed without error")

print("\n--- Test 3: silent failure on dead endpoint ---")
handler_dead = EudoraCallbackHandler(
    proxy_key="fake-key",
    agent_id="test-agent",
    eudora_base_url="http://localhost:9999"
)
run_id3 = uuid.uuid4()
handler_dead.on_llm_start({"name": "qwen3-coder:30b"}, ["test"], run_id=run_id3)
result3 = LLMResult(generations=[[Generation(text="response")]])
handler_dead.on_llm_end(result3, run_id=run_id3)
print("✓ dead endpoint did not raise — pipeline safe")

print("\nAll tests done. Check Audit Log in Eudora UI for 2 new entries.")
