import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { HistoryItem, HistoryPart } from "@/lib/types";
import { promises as fs } from "fs";
import path from "path";

// Paths for JSON "DB" and image storage folder
const DB_FILE_PATH = path.join(process.cwd(), "data", "generatedImages.json");
const IMAGE_DIR = path.join(process.cwd(), "public", "generated-images");

// Helper: Append a record to the JSON file
async function saveRecord(record) {
  let data = [];
  try {
    const content = await fs.readFile(DB_FILE_PATH, "utf-8");
    data = JSON.parse(content);
  } catch (err) {
    // If file doesn't exist, we'll create a new one\
    console.log(err)
    console.error("JSON file not found or unreadable, creating new one.");
  }
  data.push(record);
  await fs.writeFile(DB_FILE_PATH, JSON.stringify(data, null, 2));
}

// Initialize the Google Gen AI client with your API key
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Define the model ID for Gemini 2.0 Flash experimental
const MODEL_ID = "gemini-2.0-flash-exp";

// Define interface for the formatted history item (for TypeScript)
interface FormattedHistoryItem {
  role: "user" | "model";
  parts: Array<{
    text?: string;
    inlineData?: { data: string; mimeType: string };
  }>;
}

export async function POST(req: NextRequest) {
  try {
    // Parse JSON request
    const requestData = await req.json();
    const { prompt, image: inputImage, history } = requestData;

    if (!prompt) {
      return NextResponse.json(
        { error: "Prompt is required" },
        { status: 400 }
      );
    }

    // Get the model with the correct configuration
    const model = genAI.getGenerativeModel({
      model: MODEL_ID,
      generationConfig: {
        temperature: 1,
        topP: 0.95,
        topK: 40,
        // @ts-expect-error - Gemini API JS is missing this type
        responseModalities: ["Text", "Image"],
      },
    });

    let result;

    try {
      // Convert history to the format expected by Gemini API
      const formattedHistory =
        history && history.length > 0
          ? history
              .map((item: HistoryItem) => {
                return {
                  role: item.role,
                  parts: item.parts
                    .map((part: HistoryPart) => {
                      if (part.text) {
                        return { text: part.text };
                      }
                      if (part.image && item.role === "user") {
                        const imgParts = part.image.split(",");
                        if (imgParts.length > 1) {
                          return {
                            inlineData: {
                              data: imgParts[1],
                              mimeType: part.image.includes("image/png")
                                ? "image/png"
                                : "image/jpeg",
                            },
                          };
                        }
                      }
                      return { text: "" };
                    })
                    .filter((part) => Object.keys(part).length > 0),
                };
              })
              .filter((item: FormattedHistoryItem) => item.parts.length > 0)
          : [];

      // Create a chat session with the formatted history
      const chat = model.startChat({
        history: formattedHistory,
      });

      // Prepare the current message parts
      const messageParts = [];

      // Add the text prompt
      messageParts.push({ text: prompt });

      // Add the image if provided
      if (inputImage) {
        console.log("Processing image edit request");

        // Validate data URL format
        if (!inputImage.startsWith("data:")) {
          throw new Error("Invalid image data URL format");
        }

        const imageParts = inputImage.split(",");
        if (imageParts.length < 2) {
          throw new Error("Invalid image data URL format");
        }

        const base64Image = imageParts[1];
        const mimeType = inputImage.includes("image/png")
          ? "image/png"
          : "image/jpeg";
        console.log(
          "Base64 image length:",
          base64Image.length,
          "MIME type:",
          mimeType
        );

        // Add the image to message parts
        messageParts.push({
          inlineData: {
            data: base64Image,
            mimeType: mimeType,
          },
        });
      }

      // Send the message to the chat
      console.log("Sending message with", messageParts.length, "parts");
      result = await chat.sendMessage(messageParts);
    } catch (error) {
      console.error("Error in chat.sendMessage:", error);
      throw error;
    }

    const response = result.response;
    let textResponse = null;
    let imageData = null;
    let mimeType = "image/png";

    // Process the response
    if (response.candidates && response.candidates.length > 0) {
      const parts = response.candidates[0].content.parts;
      console.log("Number of parts in response:", parts.length);

      for (const part of parts) {
        if ("inlineData" in part && part.inlineData) {
          imageData = part.inlineData.data;
          mimeType = part.inlineData.mimeType || "image/png";
          console.log(
            "Image data received, length:",
            imageData.length,
            "MIME type:",
            mimeType
          );
        } else if ("text" in part && part.text) {
          textResponse = part.text;
          console.log(
            "Text response received:",
            textResponse.substring(0, 50) + "..."
          );
        }
      }
    }

    // If image data is available, store the image locally
    let storedImagePath = null;
    if (imageData) {
      // Determine file extension based on MIME type
      const extension = mimeType === "image/png" ? "png" : "jpg";
      // Generate a unique file name
      const fileName = `generatedImage-${Date.now()}.${extension}`;
      const filePath = path.join(IMAGE_DIR, fileName);

      // Ensure the image directory exists
      try {
        await fs.mkdir(IMAGE_DIR, { recursive: true });
      } catch (mkdirError) {
        console.error("Error creating image directory:", mkdirError);
      }

      // Decode the base64 image data and write to file
      const buffer = Buffer.from(imageData, "base64");
      await fs.writeFile(filePath, buffer);
      // Set the stored image path (accessible from the public folder)
      storedImagePath = `/generated-images/${fileName}`;
    }

    // Save the record (prompt and stored image path) in the JSON file
    const record = {
      prompt,
      imagePath: storedImagePath,
      createdAt: new Date().toISOString(),
    };

    try {
      await saveRecord(record);
      console.log("Record saved to JSON file");
    } catch (jsonError) {
      console.error("Error saving record to JSON file:", jsonError);
    }

    // Return the image URL (or null) and text description as JSON
    return NextResponse.json({
      image: imageData ? `data:${mimeType};base64,${imageData}` : null,
      description: textResponse,
    });
  } catch (error) {
    console.error("Error generating image:", error);
    return NextResponse.json(
      {
        error: "Failed to generate image",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
