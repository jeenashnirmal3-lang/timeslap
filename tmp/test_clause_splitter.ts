function splitIntoMasterClauses(text: string): string[] {
  let s = text.trim();
  if (!s) return [];

  // 1. Punctuation stops (. ? !)
  s = s.replace(/([.!?]+)\s+/g, "$1\n");
  s = s.replace(/\s*([:;—])\s*/g, "$1\n");
  s = s.replace(/\s+-\s+/g, "\n");

  // 2. Commas
  s = s.replace(/(?<=[^\d]),\s*/g, ",\n");

  // 3. Opening quotes (before words) and closing quotes (after words/punctuation)
  s = s.replace(/([,\s]|^)(["“‘'])([a-zA-Z0-9])/g, "$1\n$2$3");
  s = s.replace(/([a-zA-Z0-9.,!?])(["”’'])([\s,.]|$)/g, "$1$2\n$3");

  // 4. Transition & connector pause words
  const transitionWords = [
    "that", "whatever", "so", "and", "but", "because", "then", 
    "now", "meanwhile", "actually", "however", "therefore", 
    "although", "even though", "as soon as", "that is why", "that's why"
  ];
  const transRegex = new RegExp(`\\s+(?=(?:${transitionWords.join("|")})\\b)`, "gi");
  s = s.replace(transRegex, "\n");

  const rawLines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  const result: string[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];
    // If line is just a stray quote character, append to previous line or prepend to next
    if (/^[“"‘”'’]$/.test(line)) {
      if (result.length > 0) {
        result[result.length - 1] += line;
      } else if (i < rawLines.length - 1) {
        rawLines[i + 1] = line + rawLines[i + 1];
      }
      continue;
    }

    // Merge isolated 1-word connector forward
    if (i < rawLines.length - 1 && /^(?:and|or|but|so|then|that|whatever)$/i.test(line)) {
      rawLines[i + 1] = line + " " + rawLines[i + 1];
      continue;
    }

    // Capitalize first alphanumeric character
    line = line.replace(/^([^a-zA-Z]*)([a-z])/, (_m, p1, p2) => p1 + p2.toUpperCase());
    result.push(line);
  }

  return result.length > 0 ? result : [text];
}

const test1 = 'Your dog is asleep on the couch, beside you, one paw twitching. He whispered, "Wait, that cannot be right." Whatever happens next, and that is why we survived.';
console.log(splitIntoMasterClauses(test1));
