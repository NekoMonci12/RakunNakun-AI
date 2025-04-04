// messageSplitter.js

class MessageSplitter {
  /**
   * Create a new MessageSplitter instance.
   * @param {number} maxLength - Maximum allowed length per message. Defaults to 2000.
   */
  constructor(maxLength = 2000) {
    this.maxLength = maxLength;
  }

  /**
   * Splits the given message into an array of parts that do not exceed maxLength,
   * without cutting off words.
   * @param {string} message - The message to split.
   * @returns {string[]} - An array of message parts.
   */
  split(message) {
    if (message.length <= this.maxLength) return [message];

    const parts = [];
    // Split message by spaces.
    const words = message.split(' ');
    let currentPart = '';

    for (const word of words) {
      // If adding the next word would exceed maxLength, push the current part.
      if (currentPart.length + word.length + 1 > this.maxLength) {
        parts.push(currentPart.trim());
        currentPart = word + ' ';
      } else {
        currentPart += word + ' ';
      }
    }
    // Push any remaining text.
    if (currentPart.length > 0) {
      parts.push(currentPart.trim());
    }
    return parts;
  }
}

module.exports = MessageSplitter;
