import os
from dotenv import load_dotenv
from google import genai
from google.genai.errors import APIError

# Load environment variables from parent directory .env
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

def get_genai_client():
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY is not set in the environment or .env file!")
    # genai.Client() automatically picks up the GEMINI_API_KEY environment variable.
    return genai.Client()

def call_gemini_llm(prompt: str, model_name: str = "gemini-2.5-flash") -> str:
    """
    Queries the Google Gemini API with the given prompt and returns the textual response.
    Catches API errors such as rate limits (429) or invalid credentials.
    """
    try:
        client = get_genai_client()
        response = client.models.generate_content(
            model=model_name,
            contents=prompt,
        )
        if not response.text:
            return "Error: Empty response returned from Gemini LLM."
        return response.text.strip()
    except APIError as e:
        # Check if rate limits (429) or resource exhaustion occurred
        if e.code == 429:
            return (
                "Error [429]: Gemini API Rate Limit / Quota Exceeded. "
                "Please verify your billing/credits and account quotas."
            )
        return f"Error [{e.code}]: Gemini API request failed: {e.message}"
    except Exception as e:
        return f"Error: An unexpected error occurred: {str(e)}"

# Self-testing block
if __name__ == "__main__":
    print("--- Testing Gemini LLM call ---")
    prompt = "Give me a one-sentence inspirational quote about AI pair programming."
    print(f"Prompt: {prompt}")
    
    result = call_gemini_llm(prompt)
    print("\nResult:")
    print(result)
    print("--------------------------------")
