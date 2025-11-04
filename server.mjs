async function fetchImages(prompt) {
    try {
        imageContainerText.innerText = "Generating image... Please wait 15-150 seconds.";
        imageContainer.style.display = "block";
        imageGenerated.src = ""; // clear previous image

        const response = await fetch("/api/generate-image", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ prompt })
        });

        console.log("Raw response status:", response.status, response.statusText);
        const text = await response.text().catch(() => null);
        console.log("Raw response text:", text);

        // try parse JSON safely
        let data;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (err) {
            console.error("Failed to parse JSON from backend:", err);
            imageContainerText.innerText = "Error: backend returned invalid JSON.";
            return;
        }

        if (!response.ok) {
            console.error("Backend returned non-OK:", response.status, data);
            imageContainerText.innerText = data?.message || `Server error (${response.status}).`;
            return;
        }

        // existing handling
        if (data && data.images && data.images.length > 0) {
            imageGenerated.src = data.images[0];
            imageContainerText.innerText = "Here is your generated image:";
        } else {
            imageContainerText.innerText = data?.message || "No image was generated. Try a more descriptive prompt.";
        }
    } catch (error) {
        console.error("Fetch error:", error);
        imageContainerText.innerText = "Error generating image. Please try again later.";
    }
}
