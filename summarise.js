const express = require("express");
const fetch = require("node-fetch");
require("dotenv").config();
const cloudinary = require("cloudinary").v2;
const cors = require("cors");

const app = express();
const PORT = 5000;

app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());

const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMIN_API_KEY);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadFileFromStream = async (responseStream) => {
  return new Promise((resolve, reject) => {
    const cloudStream = cloudinary.uploader.upload_stream(
      { resource_type: "auto" },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    responseStream.pipe(cloudStream);
  });
};

const downloadAndUpload = async (url) => {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Failed to download file: ${response.status}`);

  return await uploadFileFromStream(response.body);
};

app.get("/", (req, res) => {
  return res.send("hello world");
});



const COHERE_API_KEY = process.env.COHERE_API_KEY;
const generateNotes = async (videoTranscript) => {
  try {
    const prompt = `
You are an expert academic assistant trained to convert educational content into structured, easy-to-understand notes **specifically for students preparing for exams or interviews**.

Your task is to convert the following video transcript into an array of JSON objects. Each object must include:

- **title**: Main subject area.
- **subtitle**: Specific subtopic or concept.
- **description**: Array of bullet points with detailed and clear explanations in simple language. Include:
  - Definitions with clarity.
  - Real-world analogies or examples where helpful.
  - Important terms in **bold** or *italic* (use Markdown).
  - Simple explanations of technical terms.
  - Step-by-step logic or breakdowns if applicable.

### Output Format:
\`\`\`json
[
  {
    "title": "Main Topic",
    "subtitle": "Subtopic",
    "description": [
      "- Clear and concise explanation of the subtopic.",
      "- Important concepts in **bold** or *italic*.",
      "- Real-world analogy: Like a traffic controller for processes.",
      "- Mention of how this concept is used in interviews/exams."
    ]
  }
]
\`\`\`

Only return the JSON array. Do **not** include any extra text or explanation.

Now process the following transcript accordingly:

"${videoTranscript}"
    `.trim();

    const response = await fetch("https://api.cohere.ai/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${COHERE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "command-r-plus",
        message: prompt,
        temperature: 0.3,
        chat_history: [],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Cohere API Error: ${err}`);
    }

    const data = await response.json();
    const outputText = data.text || data.generation;

    const jsonMatch = outputText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    let jsonContent = jsonMatch ? jsonMatch[1] : outputText;

    jsonContent = jsonContent.replace(/[\u0000-\u001F]/g, "").trim();

    if (!jsonContent.startsWith("[")) {
      jsonContent = `[${jsonContent}]`;
    }

    const structuredNotes = JSON.parse(jsonContent);
    return structuredNotes;
  } catch (error) {
    console.error("❌ Error generating notes:", error.message || error);
    return [];
  }
};

const generateQuestions = async (notes, examType) => {
  try {
    const systemPrompt = `
You are an AI that generates exam-style questions from educational notes.

Your task is to create a **JSON array** of question objects. Each object must include:
- "question": the question (string)
- "answer": the corresponding answer (string)
- "type": "short" or "long" based on answer length

### Output Example:
\`\`\`json
[
  {
    "question": "What is an operating system?",
    "answer": "An operating system is system software that manages computer hardware and software resources.",
    "type": "short"
  },
  {
    "question": "Explain the different types of operating systems.",
    "answer": "Types include batch, time-sharing, distributed, network, and real-time systems. Each is designed for specific use cases...",
    "type": "long"
  }
]
\`\`\`

Instructions:
- Mix both **short** and **long** types.
- DO NOT return anything except the JSON in the format above.
- Avoid introductory phrases like "Sure, here are your questions."
`;

    const userPrompt = `
Generate exam-style questions based on these notes:

${JSON.stringify(notes, null, 2)}

Exam type: ${examType}
`.trim();

    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    const response = await fetch("https://api.cohere.ai/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${COHERE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "command-r-plus",
        message: fullPrompt,
        temperature: 0.3,
        chat_history: [],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Cohere API Error: ${err}`);
    }

    const data = await response.json();
    const outputText = data.text || data.generation;

    const jsonMatch = outputText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    let extractedJson = jsonMatch ? jsonMatch[1] : outputText;

    extractedJson = extractedJson.replace(/[\u0000-\u001F]/g, "").trim();

    if (!extractedJson.startsWith("[")) {
      const start = extractedJson.indexOf("[");
      const end = extractedJson.lastIndexOf("]");
      extractedJson = extractedJson.substring(start, end + 1);
    }

    const questionsAndAnswers = JSON.parse(extractedJson);

    if (!Array.isArray(questionsAndAnswers)) {
      throw new Error("Invalid Response Format: Expected an array.");
    }

    for (const obj of questionsAndAnswers) {
      if (
        typeof obj !== "object" ||
        !obj.question ||
        !obj.answer ||
        !["short", "long"].includes(obj.type)
      ) {
        throw new Error(
          "Invalid Object Structure: Each entry must have 'question', 'answer', and 'type' ('short' or 'long')."
        );
      }
    }

    console.log("Mixed Q&A:", questionsAndAnswers);
    return questionsAndAnswers;
  } catch (error) {
    console.error("❌ Error generating questions:", error.message);
    return [];
  }
};


const generateRelevanceNotes = async (videoTranscript, userPrompt) => {
  try {
    const prompt = `
You are an expert content relevance analyzer.

Your task is to compare a user’s request with a transcript and output a **JSON object** with three relevance categories: high, medium, and low.

### Instructions:

1. Extract key topics/keywords from the user's request.
2. Scan the transcript and label each topic:
   - High Relevance: Clearly explained in detail (2+ bullet points)
   - Medium Relevance: Mentioned briefly (1 point)
   - Low Relevance: Not mentioned or unrelated
3. Also include unrelated **major transcript topics** in Low Relevance, prefixed with "Other:"

### Format:
\`\`\`json
{
  "high_relevance": [
    {
      "title": "Topic Name",
      "subtitle": "High Relevance",
      "description": [
        "- Explanation point 1.",
        "- Explanation point 2."
      ]
    }
  ],
  "medium_relevance": [
    {
      "title": "Topic Name",
      "subtitle": "Medium Relevance",
      "description": [
        "- Brief explanation."
      ]
    }
  ],
  "low_relevance": [
    {
      "title": "Other: Topic Name",
      "subtitle": "Low Relevance",
      "description": [
        "- Not related to the user's prompt."
      ]
    }
  ]
}
\`\`\`

DO NOT include anything outside the JSON object above.

### Transcript:
\`\`\`
${videoTranscript}
\`\`\`

### User Request:
\`\`\`
${userPrompt}
\`\`\`
`.trim();

    const response = await fetch("https://api.cohere.ai/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${COHERE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "command-r-plus",
        message: prompt,
        temperature: 0.2,
        chat_history: [],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Cohere API Error: ${err}`);
    }

    const data = await response.json();
    const outputText = data.text || data.generation;

    const jsonMatch = outputText.match(/```json\s*([\s\S]*?)\s*```/);
    let jsonText = jsonMatch ? jsonMatch[1] : outputText;

    try {
      const notes = JSON.parse(jsonText);
      return {
        high_relevance: Array.isArray(notes.high_relevance) ? notes.high_relevance : [],
        medium_relevance: Array.isArray(notes.medium_relevance) ? notes.medium_relevance : [],
        low_relevance: Array.isArray(notes.low_relevance) ? notes.low_relevance : [],
      };
    } catch {
      console.error("Failed to parse relevance JSON:", outputText);
      return {
        high_relevance: [],
        medium_relevance: [],
        low_relevance: [],
      };
    }
  } catch (err) {
    console.error("Cohere Error:", err.message);
    return {
      high_relevance: [],
      medium_relevance: [],
      low_relevance: [],
    };
  }
};

app.post("/convert-mp3", async (req, res) => {
  try {
    const { videoId, noteType } = req.body;

    console.log("videoid", videoId, "noteTtpe", noteType);

    if (!videoId) {
      return res
        .status(400)
        .json({ status: false, error: "Video ID is required" });
    }

    const response = await fetch(
      `https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`,
      {
        method: "GET",
        headers: {
          "x-rapidapi-key":
            "184ddb3d57msh00ec8e8587a680ep10d8adjsna443e5cbac1c",//api key
          "x-rapidapi-host": "youtube-mp36.p.rapidapi.com",
        },
      }
    );

    if (!response.ok) {
      console.log(`HTTP error! Status: ${response.status}`);
      return res.status(400).json({
        status: false,
        message: "Something went wrong",
      });
    }

    const data = await response.json();

    if (!data.link) {
      return res
        .status(400)
        .json({ status: false, error: "Failed to fetch MP3 link" });
    }

    const cloudinaryUrl = await downloadAndUpload(data.link);
    console.log(cloudinaryUrl);

    const requestUrl = `https://speech-to-text-ai.p.rapidapi.com/transcribe?url=${encodeURIComponent(cloudinaryUrl)}&lang=en&task=transcribe`;
    const textResponse = await fetch(
      requestUrl,
      {
        method: "POST",
        headers: {
          "x-rapidapi-key":
            "184ddb3d57msh00ec8e8587a680ep10d8adjsna443e5cbac1c", //api key
          "x-rapidapi-host": "speech-to-text-ai.p.rapidapi.com",
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (!textResponse.ok) {
      throw new Error(`HTTP error! Status: ${textResponse.status}`);
    }

    const data2 = await textResponse.json();

    const resp = await generateNotes(data2.text);

    return res.status(200).json({
      status: true,
      videoId: videoId,
      videoAudio: data?.link,
      audioCloudinaryLink: cloudinaryUrl,
      audioText: data2.text,
      structureNotes: resp,
      audioTitle: data.title,
      audioFileSize: data.filesize,
    });
  } catch (error) {
    console.error("error", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/content-analysis", async (req, res) => {
  const { videoId, userPrompt } = req.body;

  if (!videoId) {
    return res
      .status(400)
      .json({ status: false, error: "Video ID is required" });
  }

  const response = await fetch(
    `https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`,
    {
      method: "GET",
      headers: {
        "x-rapidapi-key": "184ddb3d57msh00ec8e8587a680ep10d8adjsna443e5cbac1c", //api key
        "x-rapidapi-host": "youtube-mp36.p.rapidapi.com",
      },
    }
  );

  if (!response.ok) {
    return res.status(400).json({
      status: false,
      message: "Something went wrong",
    });
  }

  const data = await response.json();

  if (!data.link) {
    return res
      .status(400)
      .json({ status: false, error: "Failed to fetch MP3 link" });
  }

  const cloudinaryUrl = await downloadAndUpload(data.link);

  const textResponse = await fetch(
    `https://speech-to-text-ai.p.rapidapi.com/transcribe?url=${cloudinaryUrl}`,
    {
      method: "POST",
      headers: {
        "x-rapidapi-key": "184ddb3d57msh00ec8e8587a680ep10d8adjsna443e5cbac1c", //api key
        "x-rapidapi-host": "speech-to-text-ai.p.rapidapi.com",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  if (!textResponse.ok) {
    throw new Error(`HTTP error! Status: ${textResponse.status}`);
  }

  const data2 = await textResponse.json();

  const resp = await generateRelevanceNotes(data2.text, userPrompt);

  return res.status(200).json({
    status: true,
    videoId: videoId,
    videoAudio: data?.link,
    audioCloudinaryLink: cloudinaryUrl,
    audioText: data2.text,
    structureNotes: resp,
    audioTitle: data.title,
    audioFileSize: data.filesize,
  });
});

app.post("/generate-questions", async (req, res) => {
  try {
    const { notes, examType } = req.body;

    if (!notes || !examType) {
      return res.status(400).json({
        status: false,
        message: "Required data need",
      });
    }

    const resp = await generateQuestions(notes, examType);
    console.log("resp", resp);

    return res.status(200).json({
      data: resp,
    });
  } catch (eror) {
    console.log("error");
    return res.status(500).json({
      status: false,
      message: "internal serveer erreor ",
    });
  }
});

app.listen(PORT, () => {
  console.log("Server running at port", PORT);
});
