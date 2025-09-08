import { GoogleGenAI, Modality, Type } from "@google/genai";
import type { GeneratedContent, Character, Page, StorySuggestion, PanelShape, ImageShape, CanvasShape, Pose, AnalysisResult } from '../types';
import { SkeletonPose, SkeletonData } from '../types';


if (!process.env.API_KEY) {
  throw new Error("API_KEY environment variable not set");
}

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

function base64ToGeminiPart(base64: string, mimeType: string) {
  return {
    inlineData: {
      data: base64.split(',')[1],
      mimeType,
    },
  };
}

export async function generateWorldview(characters: Character[]): Promise<string> {
    let prompt = `You are a creative world-builder and storyteller. Based on the following list of characters, create a compelling and imaginative worldview or setting for a manga.

**Characters:**
${characters.map(c => `- **${c.name}:** ${c.description || 'No description provided.'}`).join('\n')}

**Your Task:**
- Invent a unique setting (e.g., fantasy kingdom, sci-fi city, modern-day high school with a twist).
- Briefly describe the key rules, conflicts, or mysteries of this world.
- Explain how these characters might fit into or relate to this world.
- The tone should be creative and inspiring for a manga artist.
- Provide the response as a single block of text.
`;
    
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
    });

    return response.text;
}


export async function generateDetailedStorySuggestion(
    premise: string,
    worldview: string,
    characters: Character[],
    previousPages?: Pick<Page, 'generatedImage' | 'sceneDescription'>[]
): Promise<StorySuggestion> {
    
    let contextPrompt = "You are a creative manga scriptwriter. A user wants help writing a script for a single manga page.";

    if (worldview) {
        contextPrompt += `\n\n**IMPORTANT WORLDVIEW CONTEXT:**\n${worldview}\n\nThis worldview is the foundational truth of the story. Ensure your suggestions are consistent with these rules.`;
    }

    if (characters && characters.length > 0) {
        contextPrompt += "\n\n**CHARACTER PROFILES:**\n";
        characters.forEach(char => {
            contextPrompt += `- **${char.name}:** ${char.description || 'No description provided.'}\n`;
        });
        contextPrompt += "Incorporate these character traits into their actions and dialogue.";
    }


    const previousPagesContent: any[] = [];
    if (previousPages && previousPages.length > 0) {
        contextPrompt += "\n\n**PREVIOUS PAGE CONTEXT:**\nThis new page must be a direct continuation of the previous pages. Here is the context from the immediately preceding pages, in chronological order:";
        
        previousPages.forEach((page, index) => {
            if (page.generatedImage && page.sceneDescription) {
                contextPrompt += `\n\n**[Previous Page ${index + 1}]**\n*Script:* ${page.sceneDescription}\n*Image:* [Image ${index + 1} is attached]`;
                const mimeType = page.generatedImage.match(/data:(image\/.*?);/)?.[1] || 'image/png';
                previousPagesContent.push(base64ToGeminiPart(page.generatedImage, mimeType));
            }
        });
    }

    if (premise) {
        contextPrompt += `\n\n**USER'S PREMISE FOR THE NEW PAGE:**\n"${premise}"`;
        contextPrompt += "\n\n**YOUR TASK:**\nBased on all the context provided (worldview, characters, previous pages, user's premise), generate a detailed script for this new manga page.";
    } else {
        contextPrompt += "\n\n**YOUR TASK:**\nThe user has not provided a specific premise. Based on the worldview, characters, and the context from previous pages, propose a logical and interesting next page for the story. Generate a detailed script for this new manga page.";
    }

    contextPrompt += " Break down the story into 2-4 panels. For each panel, provide a concise description of the action/shot and any character dialogue. Panels can describe environments, objects, or close-ups without characters if it serves the story. **IMPORTANT: All dialogue MUST be in English.**";

    const contents = {
        parts: [{ text: contextPrompt }, ...previousPagesContent],
    };

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    summary: {
                        type: Type.STRING,
                        description: "A brief, one-sentence summary of the page's story."
                    },
                    panels: {
                        type: Type.ARRAY,
                        description: "An array of panel objects, describing the scene.",
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                panel: {
                                    type: Type.INTEGER,
                                    description: "The panel number (e.g., 1, 2, 3)."
                                },
                                description: {
                                    type: Type.STRING,
                                    description: "A description of the visual action, camera angle, character expressions, or environment in the panel."
                                },
                                dialogue: {
                                    type: Type.STRING,
                                    description: "The dialogue spoken by a character in the panel. Format as 'Character Name: \"Line of dialogue\"'. Can be empty."
                                }
                            },
                             required: ["panel", "description"]
                        }
                    }
                },
                required: ["summary", "panels"]
            }
        }
    });

    try {
        const jsonText = response.text;
        const suggestion = JSON.parse(jsonText) as StorySuggestion;
        // Basic validation
        if (suggestion && suggestion.summary && Array.isArray(suggestion.panels)) {
            return suggestion;
        }
        throw new Error("Parsed JSON does not match the expected structure.");
    } catch (e) {
        console.error("Failed to parse story suggestion JSON:", e);
        throw new Error("The AI returned an invalid story structure. Please try again.");
    }
}


const ASPECT_RATIO_CONFIG: { [key: string]: { w: number, h: number, value: string } } = {
    'A4': { w: 595, h: 842, value: '210:297' },
    'Portrait (3:4)': { w: 600, h: 800, value: '3:4' },
    'Square (1:1)': { w: 800, h: 800, value: '1:1' },
    'Widescreen (16:9)': { w: 1280, h: 720, value: '16:9' }
};

export async function generateLayoutProposal(
    story: string,
    characters: Character[],
    aspectRatioKey: string,
    previousPage?: { proposalImage: string, sceneDescription: string },
    currentCanvasImage?: string
): Promise<{ proposalImage: string }> {
    const config = ASPECT_RATIO_CONFIG[aspectRatioKey] || ASPECT_RATIO_CONFIG['A4'];
    const aspectRatioValue = config.value;
    const hasCharacters = characters.length > 0;

    const characterParts = hasCharacters
      ? characters.map(char => {
          const mimeType = char.sheetImage.match(/data:(image\/.*?);/)?.[1] || 'image/png';
          return base64ToGeminiPart(char.sheetImage, mimeType);
        })
      : [];
    
    const prompt = `
        You are an expert manga storyboard artist. Your task is to create a visual guide for a user by generating a single, rough, grayscale sketch of a manga page.

        **Core Objective:**
        Your primary goal is to create a DYNAMIC and VISUALLY INTERESTING panel layout that reflects professional manga storyboarding techniques. The panels should guide the reader's eye and control the pacing of the story.

        **Inputs Provided:**
        1.  **Story:** A short narrative for the manga page.
        2.  **Canvas Image:** This is the user's canvas. It may be blank or contain existing drawings. This is your drawing surface.
        3.  **Character Sheets:** ${hasCharacters ? 'Reference sheets for characters are provided.' : 'No character sheets provided.'}
        ${previousPage ? '4.  **Previous Page Image:** An image of the preceding page for context.' : ''}


        **CRITICAL INSTRUCTIONS for the SKETCH:**
        1.  **Dimensions & Aspect Ratio:** The output sketch MUST fill the entire canvas and have an exact aspect ratio of ${aspectRatioValue}. Do not leave any empty margins or padding. The image should be sized appropriately for a canvas of ${config.w}px width and ${config.h}px height.
        2.  **Creative Panel Layout:** AVOID simple, boring grid layouts. Use professional techniques:
            - **Dynamic Angles:** Use diagonally cut panels for action or unease.
            - **Overlapping & Inset Panels:** Overlap panels to show simultaneous actions or use inset panels for focus.
            - **Varying Sizes & Shapes:** Mix large and small panels. Use non-rectangular shapes to match the scene's mood.
            - **Panel Breaking:** For high impact, have characters or effects extend beyond the panel borders.
        3.  **Canvas Integration:** The provided "Canvas Image" is your drawing surface. If it contains existing user drawings, you MUST incorporate them into your layout. Propose new panels and elements that complement or complete the user's work. If it is a blank canvas, create a new layout from scratch.
        4.  **Content:**
            - **Sketch, Not Final Art:** Use rough, simple lines and basic shapes. This is a compositional guide.
            - **Character Posing:** ${hasCharacters ? "Place the characters (using their reference sheets for appearance) inside the panels." : "Sketch generic characters inside the panels based on the story."}
            - **Character-Free Panels:** If the story describes a panel with only backgrounds or objects, DO NOT draw characters in it. Sketch the described environment instead.
        5.  **ABSOLUTELY NO TEXT:** The final output image MUST NOT contain any text, labels, numbers, or annotations. It must be a pure visual sketch ONLY.
        ${previousPage ? `
        **Visual Continuity:**
        This page's layout MUST be a logical continuation of the provided "Previous Page Image". Analyze its composition and ensure a smooth visual transition. Maintain a consistent artistic style with the previous sketch.` : ''}

        **Story to Illustrate:**
        ---
        ${story}
        ---
    `;

    const parts: ({ text: string; } | { inlineData: { data: string; mimeType: string; }})[] = [{ text: prompt }];
    
    if (currentCanvasImage) {
        const mimeType = currentCanvasImage.match(/data:(image\/.*?);/)?.[1] || 'image/png';
        parts.push(base64ToGeminiPart(currentCanvasImage, mimeType));
    }

    if (previousPage?.proposalImage) {
        const mimeType = previousPage.proposalImage.match(/data:(image\/.*?);/)?.[1] || 'image/png';
        parts.push(base64ToGeminiPart(previousPage.proposalImage, mimeType));
    }
    parts.push(...characterParts);

    const contents = { parts };

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image-preview',
        contents,
        config: {
            responseModalities: [Modality.IMAGE, Modality.TEXT],
        },
    });

    if (!response.candidates?.length) {
        throw new Error("The AI did not return a valid response for the layout proposal.");
    }
    
    const imagePartResponse = response.candidates[0].content.parts.find(part => part.inlineData);
    const textPartResponse = response.candidates[0].content.parts.find(part => part.text);

    if (!imagePartResponse?.inlineData) {
        if (textPartResponse?.text) {
            throw new Error(`The AI did not return an image. Response: "${textPartResponse.text}"`);
        }
        throw new Error("The AI did not return an image for the layout proposal.");
    }

    const proposalImage = `data:${imagePartResponse.inlineData.mimeType};base64,${imagePartResponse.inlineData.data}`;
    
    return { proposalImage };
}


export async function generateCharacterSheet(
    referenceImagesBase64: string[],
    characterName: string,
    colorMode: 'color' | 'monochrome'
): Promise<string> {
    const imageParts = referenceImagesBase64.map(base64 => {
        const mimeType = base64.match(/data:(image\/.*?);/)?.[1] || 'image/png';
        return base64ToGeminiPart(base64, mimeType);
    });

    const prompt = `
        You are a professional manga artist. Your task is to create a character reference sheet for a character named "${characterName}".

        **Instructions:**
        1.  **Reference Images:** You have been provided with multiple reference images. Synthesize the key features from ALL of them to create a single, cohesive character design. For example, if one image shows a scar and another shows the character's hairstyle, include both in the final design.
        2.  **Style:** Generate the sheet in a clean, ${colorMode === 'monochrome' ? 'black and white (monochrome)' : 'full color'} manga style, suitable for an artist's reference.
        3.  **Content & Layout:** The character sheet must include exactly six poses, arranged in two rows:
            - **Top Row (Headshots):** Three headshots showing different views and expressions (e.g., side view, front view neutral expression, front view smiling).
            - **Bottom Row (Full Body):** Three full-body views (front, side, and back).
        4.  **Output:** Generate ONLY the final character sheet as a single image. Do NOT include any text, labels, names, descriptions, or explanations in your response. The output must be the image and nothing else.
    `;

    const contents = {
        parts: [{ text: prompt }, ...imageParts],
    };

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image-preview',
        contents,
        config: {
            responseModalities: [Modality.IMAGE, Modality.TEXT],
        },
    });

     if (!response.candidates?.length) {
        throw new Error("The AI did not return a valid response for the character sheet. It may have been blocked.");
    }
    
    const imagePartResponse = response.candidates[0].content.parts.find(part => part.inlineData);

    if (imagePartResponse?.inlineData) {
        const base64ImageBytes: string = imagePartResponse.inlineData.data;
        const responseMimeType = imagePartResponse.inlineData.mimeType;
        return `data:${responseMimeType};base64,${base64ImageBytes}`;
    }

    const textPartResponse = response.candidates[0].content.parts.find(part => part.text);
    if(textPartResponse?.text) {
        throw new Error(`The AI did not return an image. Response: "${textPartResponse.text}"`);
    }

    throw new Error("The AI did not return an image for the character sheet.");
}

export async function generateCharacterFromReference(
    referenceSheetImagesBase64: string[],
    characterName: string,
    characterConcept: string,
    colorMode: 'color' | 'monochrome'
): Promise<string> {
    const imageParts = referenceSheetImagesBase64.map(base64 => {
        const mimeType = base64.match(/data:(image\/.*?);/)?.[1] || 'image/png';
        return base64ToGeminiPart(base64, mimeType);
    });

    const prompt = `
        You are a professional manga artist. Your task is to create a **completely new and original character** named "${characterName}" by using existing character sheets purely as **ART STYLE REFERENCES**.

        **CRITICAL INSTRUCTIONS - READ CAREFULLY:**
        1.  **ART STYLE ONLY:** You have been provided with character sheets to be used as **art style references only**. Analyze their line art, coloring style (if applicable), shading techniques, and overall aesthetic. Your final output's art style MUST be a synthesis of these references.
        2.  **DO NOT COPY THE REFERENCE CHARACTERS. THIS IS THE MOST IMPORTANT RULE.** You are creating a **NEW** character from the ground up. You are strictly forbidden from copying or closely imitating the designs, physical features (hair style, face shape, eyes), clothing, accessories, or identities of the characters in the reference sheets. The references are for the drawing *style*, not the character *design*.
        3.  **NEW CHARACTER CONCEPT:** The new character, "${characterName}", MUST be based ENTIRELY on the following description: "${characterConcept}". This description is the single source of truth for the character's appearance and design.
        4.  **Style:** Generate the sheet in a clean, ${colorMode === 'monochrome' ? 'black and white (monochrome)' : 'full color'} manga style, matching the reference styles.
        5.  **Content & Layout:** The character sheet must include exactly six poses, arranged in two rows:
            - **Top Row (Headshots):** Three headshots showing different views and expressions (e.g., side view, front view neutral expression, front view smiling).
            - **Bottom Row (Full Body):** Three full-body views (front, side, and back).
        6.  **Output:** Generate ONLY the final character sheet as a single image. Do NOT include any text, labels, names, descriptions, or explanations in your response. The output must be the image and nothing else.
    `;

    const contents = {
        parts: [{ text: prompt }, ...imageParts],
    };

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image-preview',
        contents,
        config: {
            responseModalities: [Modality.IMAGE, Modality.TEXT],
        },
    });

     if (!response.candidates?.length) {
        throw new Error("The AI did not return a valid response for the character sheet. It may have been blocked.");
    }
    
    const imagePartResponse = response.candidates[0].content.parts.find(part => part.inlineData);

    if (imagePartResponse?.inlineData) {
        const base64ImageBytes: string = imagePartResponse.inlineData.data;
        const responseMimeType = imagePartResponse.inlineData.mimeType;
        return `data:${responseMimeType};base64,${base64ImageBytes}`;
    }

    const textPartResponse = response.candidates[0].content.parts.find(part => part.text);
    if(textPartResponse?.text) {
        throw new Error(`The AI did not return an image. Response: "${textPartResponse.text}"`);
    }

    throw new Error("The AI did not return an image for the character sheet.");
}


export async function editCharacterSheet(
    sheetImageBase64: string,
    characterName: string,
    editPrompt: string
): Promise<string> {
    const mimeType = sheetImageBase64.match(/data:(image\/.*?);/)?.[1] || 'image/png';
    const imagePart = base64ToGeminiPart(sheetImageBase64, mimeType);

    const prompt = `
        You are a professional manga artist. Your task is to edit a character reference sheet for a character named "${characterName}".

        **Instructions:**
        1.  **Reference Image:** Use the provided character sheet as the base.
        2.  **Edit Request:** The user wants the following modification: "${editPrompt}".
        3.  **Execution:** Apply the requested change to the character across all poses on the sheet. Maintain the existing style, layout, and overall design.
        4.  **Output:** Generate ONLY the final, updated character sheet as a single image. Do not include any text, labels, or explanations.
    `;
    
    const contents = {
        parts: [{ text: prompt }, imagePart],
    };

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image-preview',
        contents,
        config: {
            responseModalities: [Modality.IMAGE, Modality.TEXT],
        },
    });

    if (!response.candidates?.length) {
        throw new Error("The AI did not return a valid response for the character sheet edit.");
    }
    
    const imagePartResponse = response.candidates[0].content.parts.find(part => part.inlineData);
    if (imagePartResponse?.inlineData) {
        return `data:${imagePartResponse.inlineData.mimeType};base64,${imagePartResponse.inlineData.data}`;
    }

    throw new Error("The AI did not return an updated image for the character sheet.");
}

export async function generateMangaPage(
  characters: Character[],
  panelLayoutImageBase64: string,
  sceneDescription: string,
  colorMode: 'color' | 'monochrome',
  previousPage: Pick<Page, 'generatedImage' | 'sceneDescription'> | undefined,
  generateEmptyBubbles: boolean
): Promise<GeneratedContent> {
  const panelMimeType = panelLayoutImageBase64.match(/data:(image\/.*?);/)?.[1] || 'image/png';
  const panelLayoutPart = base64ToGeminiPart(panelLayoutImageBase64, panelMimeType);
  
  const charactersInScene = characters;
  
  const characterParts = charactersInScene.map(char => {
    const mimeType = char.sheetImage.match(/data:(image\/.*?);/)?.[1] || 'image/png';
    return base64ToGeminiPart(char.sheetImage, mimeType);
  });

  const characterReferencePrompt = charactersInScene.map((char, index) => 
    `- **${char.name}:** Use the character sheet provided as "Character Reference ${index + 1}".`
  ).join('\n');

  const hasPreviousPage = previousPage && previousPage.generatedImage;

  const continuationInstruction = hasPreviousPage
    ? `
**CRUCIAL CONTEXT - STORY CONTINUATION:**
This page MUST be a direct continuation of the previous page provided. Analyze the "Previous Page Image" and its script to ensure seamless narrative and artistic continuity. Maintain character appearances, outfits, locations, and a overall mood from the previous page.

**Previous Page Script:**
---
${previousPage.sceneDescription}
---
`
    : '';

  const assetsPrompt = `
    1.  **Character Sheets:** For each character that appears.
    2.  **Panel Layout with Poses:** An image showing the panel composition for the NEW page. This image ALSO CONTAINS visual pose guides for each character, clearly labeled with the character's name.
    3.  **Scene Script:** A detailed, panel-by-panel description of the actions, expressions, and composition for the NEW page.
  `;
  
  const prompt = `
    You are an expert manga artist. Your task is to create a single manga page based on the provided assets and a detailed script.

    **Assets Provided:**
    ${hasPreviousPage ? '1.  **Previous Page Image:** An image of the preceding page for story context.' : ''}
    ${assetsPrompt.replace(/^\s*(\d+)/gm, (match, n) => `    ${hasPreviousPage ? parseInt(n) + 1 : n}`)}

    **Character References:**
    ${characterReferencePrompt}
    
    ${continuationInstruction}

    **Instructions for the NEW page:**
    1.  **Crucial - Match Poses to Characters:** The Panel Layout image labels each pose with a character's name. You MUST use the correct character sheet for the named character and draw them in that pose. If there is a text comment next to a character's pose, use it as a primary instruction for their action.
    2.  **Strictly Follow the Script:** The Scene Script is your guide for expressions, shot composition, and narrative context. Execute these details precisely. If the script describes a scene without characters (e.g., a landscape, a close-up of an object), you MUST draw that scene instead of a character.
    3.  **Character Consistency & Count:** Draw the characters strictly according to their reference sheets for appearance. **Crucially, only draw the number of characters specified in the script and layout guide for each panel. Do not add extra characters or omit specified characters.**
    4.  **Panel Layout & Sizing:** Use the provided panel layout for the comic's structure. **The relative size of each panel in the layout image indicates its narrative importance. Larger panels should depict key moments with more detail, dynamic composition, and focus.**
    5.  **Color & Style:** Create the manga in ${colorMode === 'monochrome' ? 'black and white (monochrome)' : 'full color'}. **All text and speech bubbles must have bold, clear, and thick black outlines.**
    6.  **Speech Bubbles:** ${generateEmptyBubbles ? 'The panel layout image may contain speech bubble shapes. You MUST draw these speech bubbles, but leave them COMPLETELY EMPTY. Do NOT add any text, dialogue, or sound effects inside them.' : 'If the script includes dialogue, place it inside the speech bubbles drawn in the panel layout. If there are no bubbles in the layout but there is dialogue, create appropriate bubbles.'}
    7.  **Final Output:** Generate ONLY the final manga page as a single image. Do not include any text, descriptions, or explanations.

    **Scene Script for the NEW Page:**
    ---
    ${sceneDescription}
    ---
  `;
  
  const parts: ({ text: string; } | { inlineData: { data: string; mimeType: string; }})[] = [{ text: prompt }];
  if (hasPreviousPage) {
    const prevPageMimeType = previousPage.generatedImage.match(/data:(image\/.*?);/)?.[1] || 'image/png';
    parts.push(base64ToGeminiPart(previousPage.generatedImage, prevPageMimeType));
  }
  parts.push(...characterParts, panelLayoutPart);

  const contents = { parts };

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image-preview',
    contents,
    config: {
      responseModalities: [Modality.IMAGE, Modality.TEXT],
    }
  });
  
  let result: GeneratedContent = { image: null, text: null };

  if (!response.candidates?.length) {
    throw new Error("The AI did not return a valid response. It may have been blocked. " + (response.text || ""));
  }

  for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const base64ImageBytes: string = part.inlineData.data;
        const mimeType = part.inlineData.mimeType;
        result.image = `data:${mimeType};base64,${base64ImageBytes}`;
      } else if (part.text) {
        result.text = part.text;
      }
  }

  if (!result.image) {
      throw new Error("The AI did not return an image. It might have refused the request. " + (result.text || ""));
  }

  return result;
}

export async function colorizeMangaPage(
    monochromePageBase64: string,
    characters: Character[]
): Promise<string> {
    const pageMimeType = monochromePageBase64.match(/data:(image\/.*?);/)?.[1] || 'image/png';
    const pagePart = base64ToGeminiPart(monochromePageBase64, pageMimeType);

    const characterParts: { inlineData: { data: string; mimeType: string; } }[] = [];
    const characterReferencePrompt = characters.map(char => {
        char.referenceImages.forEach(refImg => {
            const mimeType = refImg.match(/data:(image\/.*?);/)?.[1] || 'image/png';
            characterParts.push(base64ToGeminiPart(refImg, mimeType));
        });
        const sheetMimeType = char.sheetImage.match(/data:(image\/.*?);/)?.[1] || 'image/png';
        characterParts.push(base64ToGeminiPart(char.sheetImage, sheetMimeType));
        
        return `- **${char.name}:** Use the provided full-color reference images for ACCURATE color information (hair, eyes, clothing, etc.). Use the black-and-white sheet to understand the character's design and line art.`
    }).join('\n');

    const prompt = `
        You are a professional digital colorist for manga. Your task is to fully color a monochrome manga page.

        **Assets Provided:**
        1.  **Monochrome Manga Page:** The page that needs to be colored.
        2.  **Character References:** For each character, one or more full-color images and one black-and-white character sheet are provided in sequence.

        **Character Color & Design References:**
        ${characterReferencePrompt}

        **Instructions:**
        1.  **Full Colorization:** You must color the ENTIRE page. This includes all characters, objects, backgrounds, and effects within every panel. Do not leave any areas monochrome.
        2.  **CRUCIAL - Accurate Character Colors:** This is the most important rule. You MUST use the provided ORIGINAL, FULL-COLOR reference images to ensure that each character is colored with their correct and consistent color scheme. If multiple color references are given for one character, synthesize the colors logically.
        3.  **Maintain Line Art:** Preserve the original black line art. Do not redraw or alter it. Your primary task is to add color to the provided black and white image, not to create a new drawing.
        4.  **Cohesive Palette:** Ensure the background and environment colors are plausible and create a cohesive mood for the scene.
        5.  **Output:** Generate ONLY the final, fully colored manga page as a single image.
    `;

    const contents = {
        parts: [{ text: prompt }, pagePart, ...characterParts],
    };

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image-preview',
        contents,
        config: {
            responseModalities: [Modality.IMAGE, Modality.TEXT],
        },
    });

    if (!response.candidates?.length) {
        throw new Error("The AI did not return a valid response for colorization.");
    }
    
    const imagePartResponse = response.candidates[0].content.parts.find(part => part.inlineData);
    if (imagePartResponse?.inlineData) {
        return `data:${imagePartResponse.inlineData.mimeType};base64,${imagePartResponse.inlineData.data}`;
    }

    throw new Error("The AI did not return a colored image.");
}

export async function editMangaPage(
    originalImageBase64: string,
    prompt: string,
    maskImageBase64?: string,
    referenceImagesBase64?: string[]
): Promise<string> {
    const originalMimeType = originalImageBase64.match(/data:(image\/.*?);/)?.[1] || 'image/png';
    const originalImagePart = base64ToGeminiPart(originalImageBase64, originalMimeType);

    let fullPrompt = `You are a professional manga artist and expert digital editor. Your task is to edit the provided manga page image based on the user's instructions.`;

    if (maskImageBase64) {
        fullPrompt += `

**CRITICAL INSTRUCTIONS FOR MASKING:**
You have been provided with an original image and a mask image. Your task is to **COMPLETELY RE-RENDER** the area of the original image that is **WHITE** in the mask image. 
- The **BLACK** areas of the mask must remain **COMPLETELY UNCHANGED** from the original image. 
- You must apply the user's text prompt to the **ENTIRE WHITE MASKED AREA**. The change should be comprehensive and not subtle.
- Ensure the result blends seamlessly and naturally with the unchanged parts of the image.

**User's Request:** "${prompt}"
`;
    } else {
        fullPrompt += `

**User's Request:** "${prompt}"

**Instructions:**
Apply the requested changes to the entire image as appropriate.
`;
    }

    if (referenceImagesBase64 && referenceImagesBase64.length > 0) {
        fullPrompt += `
**IMPORTANT REFERENCE IMAGES:**
You have been provided with ${referenceImagesBase64.length} reference image(s). These may include character sheets or other visual guides.
- If your task involves adding or correcting a character, you **MUST** use the provided reference images to draw them with perfect accuracy to their design, features, and clothing.
- Use these images as the primary source of truth for style and content in your edits.`;
    }

    fullPrompt += `\n**Final Output:** You must generate ONLY the final, edited image. Do not include any text, labels, or explanations in your response.`;

    const parts: ({ text: string } | { inlineData: { data: string, mimeType: string } })[] = [
        { text: fullPrompt },
        originalImagePart
    ];

    if (maskImageBase64) {
        const maskMimeType = maskImageBase64.match(/data:(image\/.*?);/)?.[1] || 'image/png';
        parts.push(base64ToGeminiPart(maskImageBase64, maskMimeType));
    }
    if (referenceImagesBase64) {
        referenceImagesBase64.forEach(refImg => {
            const refMimeType = refImg.match(/data:(image\/.*?);/)?.[1] || 'image/png';
            parts.push(base64ToGeminiPart(refImg, refMimeType));
        });
    }
    
    const contents = { parts };

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image-preview',
        contents,
        config: {
            responseModalities: [Modality.IMAGE, Modality.TEXT],
        },
    });

    if (!response.candidates?.length) {
        throw new Error("The AI did not return a valid response for the image edit.");
    }
    
    const imagePartResponse = response.candidates[0].content.parts.find(part => part.inlineData);
    if (imagePartResponse?.inlineData) {
        return `data:${imagePartResponse.inlineData.mimeType};base64,${imagePartResponse.inlineData.data}`;
    }

    const textPartResponse = response.candidates[0].content.parts.find(part => part.text);
    if (textPartResponse?.text) {
      throw new Error(`The AI did not return an image. Response: "${textPartResponse.text}"`);
    }

    throw new Error("The AI did not return an edited image.");
}


export async function analyzeAndSuggestCorrections(
    panelLayoutImage: string,
    generatedImage: string,
    sceneDescription: string,
    characters: Character[]
): Promise<AnalysisResult> {
    const layoutMimeType = panelLayoutImage.match(/data:(image\/.*?);/)?.[1] || 'image/png';
    const layoutPart = base64ToGeminiPart(panelLayoutImage, layoutMimeType);
    const generatedMimeType = generatedImage.match(/data:(image\/.*?);/)?.[1] || 'image/png';
    const generatedPart = base64ToGeminiPart(generatedImage, generatedMimeType);

    const characterInfo = characters.map(c => `- ${c.name}`).join('\n');

    const prompt = `
You are a meticulous Quality Assurance assistant for a manga creation tool. Your task is to analyze a generated manga page and suggest corrections if it deviates from the original plan.

**Provided Assets:**
1.  **Layout & Pose Guide (Image 1):** This is the user's plan. It shows the panel layout and contains labeled skeleton poses for characters.
2.  **Generated Manga Page (Image 2):** This is the final image produced by the AI artist.
3.  **Scene Script:** The text description of what should happen on the page.
4.  **Character List:** The names of characters involved.

**Your Analysis Task:**
Carefully compare the "Generated Manga Page" against the "Layout & Pose Guide" and the "Scene Script". Look for discrepancies such as:
-   **Missing or Incorrect Characters:** Is a character from the script/guide missing, or is the wrong character used?
-   **Incorrect Poses:** Does the character's pose in the final image significantly differ from the skeleton guide?
-   **Layout Deviations:** Are the panel shapes and arrangement different from the guide?
-   **Script Contradictions:** Does the final image contradict the actions or descriptions in the script?
-   **Character Duplication:** Check if the same character appears multiple times within the same panel or in a way that is logically impossible for the scene. For example, a character cannot be in two places at once unless the script specifies a clone, twin, or magical effect.
-   **Contextual Inappropriateness:** Analyze if characters are placed in situations that contradict their role or the scene's logic. For example, a character who is supposed to be hiding should not be in the open. A character described as sad should not have an inappropriately cheerful pose.

**Your Output:**
You MUST respond with a single JSON object with the following structure:
{
  "analysis": "A brief, human-readable summary of your findings. Describe any discrepancies you found, or state that the image is accurate.",
  "has_discrepancies": boolean, // true if you found any issues, false otherwise.
  "correction_prompt": "If has_discrepancies is true, write a detailed, specific, and clear instruction prompt for an image editing AI to fix ALL the identified issues in one go. If false, this should be an empty string."
}

**Example Correction Prompt:**
"In the top-left panel, redraw the character 'Kaito' to match the skeleton pose, making sure he is holding a sword. In the bottom panel, add the character 'Anya' who is currently missing; she should be shown looking surprised. On the right, the two instances of 'Kaito' are a mistake, remove the one that is further back. Keep the art style consistent."

**Scene Script:**
---
${sceneDescription}
---

**Characters in Scene:**
${characterInfo}
`;
    const contents = {
        parts: [{ text: prompt }, layoutPart, generatedPart],
    };

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    analysis: { type: Type.STRING },
                    has_discrepancies: { type: Type.BOOLEAN },
                    correction_prompt: { type: Type.STRING },
                },
                required: ["analysis", "has_discrepancies", "correction_prompt"]
            }
        }
    });
    
    try {
        const jsonText = response.text;
        const result = JSON.parse(jsonText) as AnalysisResult;
        return result;
    } catch (e) {
        console.error("Failed to parse analysis JSON:", e);
        throw new Error("The AI returned an invalid analysis structure.");
    }
}