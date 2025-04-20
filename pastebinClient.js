// pastebinClient.js

const axios = require('axios');
const qs = require('qs'); // for form URL-encoded data

class PastebinClient {
  /**
   * Create a new PastebinClient instance.
   * @param {string} devKey - Your Pastebin developer key.
   */
  constructor(devKey) {
    this.devKey = devKey;
    this.apiUrl = 'https://pastebin.com/api/api_post.php';
  }

  /**
   * Creates a new paste on Pastebin.
   * @param {string} text - The text to paste.
   * @param {string} expireDate - Expiration for the paste (e.g. '1M' for 1 month).
   * @param {string} pasteName - Optional paste title.
   * @param {string} pasteFormat - Optional paste format.
   * @param {number} pastePrivate - 0=public, 1=unlisted, 2=private.
   * @returns {Promise<string>} - The URL of the created paste.
   */
  async createPaste(text, expireDate = '1M', pasteName = 'Chat Log', pasteFormat = '', pastePrivate = 1) {
    // Prepare the payload as form URL encoded data.
    const payload = {
      api_dev_key: this.devKey,
      api_option: 'paste',
      api_paste_code: text,
      api_paste_expire_date: expireDate, // "1M" for 1 month
      api_paste_name: pasteName,
      api_paste_format: pasteFormat,
      api_paste_private: pastePrivate,
    };

    try {
      const response = await axios.post(this.apiUrl, qs.stringify(payload), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      // If Pastebin returns a URL, then paste creation succeeded.
      // If not, it might return an error message.
      if (response.data.startsWith('http')) {
        return response.data;
      } else {
        throw new Error(`Pastebin error: ${response.data}`);
      }
    } catch (error) {
      throw new Error(`Pastebin API request failed: ${error.message}`);
    }
  }
}

module.exports = PastebinClient;
