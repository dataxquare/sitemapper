/**
 * Sitemap Parser
 *
 * Copyright (c) 2024 Sean Thomas Burke
 * Licensed under the MIT license.
 * @author Sean Burke <@seantomburke>
 */

import { XMLParser } from 'fast-xml-parser';
import got_default from 'got';
import zlib from 'zlib';
import isGzip from 'is-gzip';

/**
 * @typedef {Object} Sitemapper
 */
export default class Sitemapper {
  /**
   * Construct the Sitemapper class
   *
   * @params {Object} options to set
   * @params {string} [options.url] - the Sitemap url (e.g https://wp.seantburke.com/sitemap.xml)
   * @params {Timeout} [options.timeout] - @see {timeout}
   * @params {boolean} [options.debug] - Enables/Disables additional logging
   * @params {integer} [options.retries] - The maximum number of retries to attempt when crawling fails (e.g. 1 for 1 retry, 2 attempts in total)
   * @params {boolean} [options.rejectUnauthorized] - If true (default), it will throw on invalid certificates, such as expired or self-signed ones.
   * @params {lastmod} [options.lastmod] - the minimum lastmod value for urls
   * @params {hpagent.HttpProxyAgent|hpagent.HttpsProxyAgent} [options.proxyAgent] - instance of npm "hpagent" HttpProxyAgent or HttpsProxyAgent to be passed to npm "got"
   * @params {Array<RegExp>} [options.exclusions] - Array of regex patterns to exclude URLs
   * @params {Array<RegExp>} [options.includes] - Array of regex patterns to INCLUDE URLs. Only URLs matching one of these patterns will be kept.
   * @params {number} [options.limit] - The maximum number of URLs to extract from the sitemap(s). Extraction stops once this limit is reached.
   * @params {Object} [options.requestClient] - An optional custom 'got' instance to use for HTTP requests. Useful for testing or custom configurations.
   *
   * @example let sitemap = new Sitemapper({
   *   url: 'https://wp.seantburke.com/sitemap.xml',
   *   timeout: 15000,
   *   lastmod: 1630693759,
   *   exclusions: [/foo.com/, /bar.xml/] // Filters out URLs matching these patterns
   *  });
   */
  constructor(options) {
    const settings = options || { requestHeaders: {} };
    this.url = settings.url;
    this.timeout = settings.timeout || 15000;
    this.timeoutTable = {};
    this.lastmod = settings.lastmod || 0;
    this.requestHeaders = settings.requestHeaders;
    this.debug = settings.debug;
    this.retries = settings.retries || 0;
    this.rejectUnauthorized =
      settings.rejectUnauthorized === false ? false : true;
    this.fields = settings.fields || false;
    this.proxyAgent = settings.proxyAgent || {};
    this.exclusions = settings.exclusions || [];
    this.includes = settings.includes || [];
    this.limit = settings.limit || 1000;
    this.requestClient = settings.requestClient || got_default;
    this.uniqueSites = new Set();
  }

    /**
   * Fetches the robots.txt file, extracts sitemap URLs, and then crawls those sitemaps.
   *
   * @public
   * @param {string} [robotsTxtUrl] - The URL of the robots.txt file (e.g., 'https://example.com/robots.txt').
   * If not provided, it will attempt to construct it from the base URL.
   * @returns {Promise<RobotsData>}
   * @example
   * let sitemap = new Sitemapper({ limit: 50 });
   * sitemap.fetchRobots('https://www.weforum.org/robots.txt')
   * .then(data => {
   * console.log('Sitemaps found in robots.txt:', data.sitemaps.length);
   * console.log('URLs collected from sitemaps:', data.sites.length);
   * });
   */
  async fetchRobots(robotsTxtUrl = null) {
    this.uniqueSites = new Set();

    const baseUrl = robotsTxtUrl
      ? robotsTxtUrl.substring(0, robotsTxtUrl.lastIndexOf('/') + 1)
      : this.url.substring(0, this.url.lastIndexOf('/') + 1);

    const actualRobotsTxtUrl = robotsTxtUrl || `${baseUrl}robots.txt`;

    let robotsResults = {
      url: actualRobotsTxtUrl,
      sitemaps: [],
      sites: [],
      errors: [],
    };

    if (this.debug) {
      console.debug(`Fetching robots.txt from: ${actualRobotsTxtUrl}`);
      if (this.limit !== Infinity) {
        console.debug(`Limiting total URLs extracted to ${this.limit}`);
      }
    }

    try {
      const { error, data: robotsTxtContent, type } = await this.parseRobots(actualRobotsTxtUrl);

      if (error) {
        robotsResults.errors.push({
          type: type || 'RobotsParseError',
          message: error,
          url: actualRobotsTxtUrl,
          retries: 0,
        });
        if (this.debug) {
          console.error(`Error parsing robots.txt: ${error}`);
        }
      } else {
        const sitemapUrls = this.extractSitemapsFromRobots(robotsTxtContent);
        robotsResults.sitemaps = sitemapUrls;

        if (this.debug) {
          console.debug(`Found ${sitemapUrls.length} sitemaps in robots.txt.`);
          sitemapUrls.forEach(sUrl => console.debug(`  - ${sUrl}`));
        }

        for (const sitemapUrl of sitemapUrls) {
          if (this.uniqueSites.size >= this.limit) {
            if (this.debug) {
              console.debug(`Limit of ${this.limit} reached. Stopping further sitemap crawls from robots.txt.`);
            }
            break;
          }

          if (this.debug) {
              console.debug(`Crawling sitemap from robots.txt: ${sitemapUrl}`);
          }
          const { sites: crawledSites, errors: crawledErrors } = await this.crawl(sitemapUrl, 0, this.uniqueSites);
          
          robotsResults.errors.push(...crawledErrors);
        }
      }
    } catch (e) {
      robotsResults.errors.push({
        type: 'GeneralRobotsError',
        message: e.message,
        url: actualRobotsTxtUrl,
        retries: 0,
      });
      if (this.debug) {
        console.error(`Unhandled error in fetchRobots: ${e}`);
      }
    }

    const finalSites = Array.from(this.uniqueSites).slice(0, this.limit);
    robotsResults.sites = finalSites;

    return robotsResults;
  }

  /**
   * Fetches and parses a robots.txt file.
   *
   * @private
   * @param {string} url - The URL of the robots.txt file.
   * @returns {Promise<ParseData>} Returns content in data.
   */
  async parseRobots(url) {
    const requestOptions = {
      method: 'GET',
      resolveWithFullResponse: true,
      headers: this.requestHeaders,
      https: {
        rejectUnauthorized: this.rejectUnauthorized,
      },
      agent: this.proxyAgent,
    };

    try {
      const requester = this.requestClient.get(url, requestOptions);
      this.initializeTimeout(url, requester);
      const response = await requester;

      if (!response || response.statusCode !== 200) {
        clearTimeout(this.timeoutTable[url]);
        return { error: response.error, data: response, type: 'HTTPError' };
      }

      return { error: null, data: response.body, type: 'Success' };
    } catch (error) {
      if (error.name === 'CancelError') {
        return {
          error: `Request timed out after ${this.timeout} milliseconds for url: '${url}'`,
          data: error,
          type: 'CancelError'
        };
      }
      if (error.name === 'HTTPError') {
        return {
          error: `HTTP Error occurred: ${error.message}`,
          data: error,
          type: 'HTTPError'
        };
      }
      return {
        error: `Error occurred: ${error.name}`,
        data: error,
        type: error.name
      };
    }
  }

  /**
   * Extracts Sitemap URLs from robots.txt content.
   *
   * @private
   * @param {string} robotsTxtContent - The content of the robots.txt file.
   * @returns {string[]} An array of sitemap URLs found.
   */
  extractSitemapsFromRobots(robotsTxtContent) {
    const sitemapUrls = [];
    const lines = robotsTxtContent.split('\n');
    const sitemapRegex = /^Sitemap:\s*(.*)/i;

    for (const line of lines) {
      const match = line.match(sitemapRegex);
      if (match && match[1]) {
        sitemapUrls.push(match[1].trim());
      }
    }
    return sitemapUrls;
  }

  /**
   * Gets the sites from a sitemap.xml with a given URL
   *
   * @public
   * @param {string} [url] - the Sitemaps url (e.g https://wp.seantburke.com/sitemap.xml)
   * @returns {Promise<SitesData>}
   * @example sitemapper.fetch('example.xml')
   * .then((sites) => console.log(sites));
   */
  async fetch(url = this.url) {
    // Reset uniqueSites for each new fetch operation
    this.uniqueSites = new Set();

    let results = {
      url: '',
      sites: [],
      errors: [],
    };

    if (this.debug) {
      if (this.lastmod) {
        console.debug(`Using minimum lastmod value of ${this.lastmod}`);
      }
      if (this.limit !== Infinity) {
        console.debug(`Limiting total URLs extracted to ${this.limit}`);
      }
    }

    try {
      results = await this.crawl(url, 0, this.uniqueSites);
    } catch (e) {
      if (this.debug) {
        console.error(e);
      }
    }

    const finalSites = Array.from(results.sites).slice(0, this.limit);

    return {
      url,
      sites: finalSites || [],
      errors: results.errors || [],
    };
  }

  /**
   * Get the timeout
   *
   * @example console.log(sitemapper.timeout);
   * @returns {Timeout}
   */
  static get timeout() {
    return this.timeout;
  }

  /**
   * Set the timeout
   *
   * @public
   * @param {Timeout} duration
   * @example sitemapper.timeout = 15000; // 15 seconds
   */
  static set timeout(duration) {
    this.timeout = duration;
  }

  /**
   * Get the lastmod minimum value
   *
   * @example console.log(sitemapper.lastmod);
   * @returns {number}
   */
  static get lastmod() {
    return this.lastmod;
  }

  /**
   * Set the lastmod minimum value
   *
   * @public
   * @param {number} timestamp
   * @example sitemapper.lastmod = 1630694181; // Unix timestamp
   */
  static set lastmod(timestamp) {
    this.lastmod = timestamp;
  }

  /**
   *
   * @param {string} url - url for making requests. Should be a link to a sitemaps.xml
   * @example sitemapper.url = 'https://wp.seantburke.com/sitemap.xml'
   */
  static set url(url) {
    this.url = url;
  }

  /**
   * Get the url to parse
   * @returns {string}
   * @example console.log(sitemapper.url)
   */
  static get url() {
    return this.url;
  }

  /**
   * Setter for the debug state
   * @param {boolean} option - set whether to show debug logs in output.
   * @example sitemapper.debug = true;
   */
  static set debug(option) {
    this.debug = option;
  }

  /**
   * Getter for the debug state
   * @returns {boolean}
   * @example console.log(sitemapper.debug)
   */
  static get debug() {
    return this.debug;
  }

  /**
   * Requests the URL and uses fast-xml-parser to parse through and find the data
   *
   * @private
   * @param {string} [url] - the Sitemaps url (e.g https://wp.seantburke.com/sitemap.xml)
   * @returns {Promise<ParseData>}
   */
  async parse(url = this.url) {
    // setup the response options for the got request
    const requestOptions = {
      method: 'GET',
      resolveWithFullResponse: true,
      gzip: true,
      responseType: 'buffer',
      headers: this.requestHeaders,
      https: {
        rejectUnauthorized: this.rejectUnauthorized,
      },
      agent: this.proxyAgent,
    };

    try {
      // create a request Promise with the url and request options
      const requester = this.requestClient.get(url, requestOptions);

      // initialize the timeout method based on the URL, and pass the request object.
      this.initializeTimeout(url, requester);

      // get the response from the requester promise
      const response = await requester;

      // if the response does not have a successful status code then clear the timeout for this url.
      if (!response || response.statusCode !== 200) {
        clearTimeout(this.timeoutTable[url]);
        return { error: response.error, data: response, type: 'HTTPError' };
      }

      let responseBody;

      if (isGzip(response.rawBody)) {
        responseBody = await this.decompressResponseBody(response.body);
      } else {
        responseBody = response.body;
      }

      // Parse XML using fast-xml-parser
      const parser = new XMLParser({
        isArray: (tagName) =>
          ['sitemap', 'url'].some((value) => value === tagName),
        removeNSPrefix: true,
      });

      const data = parser.parse(responseBody.toString());
      return { error: null, data, type: 'Success' };
    } catch (error) {
      // If the request was canceled notify the user of the timeout
      if (error.name === 'CancelError') {
        return {
          error: `Request timed out after ${this.timeout} milliseconds for url: '${url}'`,
          data: error,
          type: 'CancelError',
        };
      }

      // If an HTTPError include error http code
      if (error.name === 'HTTPError') {
        return {
          error: `HTTP Error occurred: ${error.message}`,
          data: error,
          type: 'HTTPError',
        };
      }

      // Otherwise notify of another error
      return {
        error: `Error occurred: ${error.name}`,
        data: error,
        type: error.name,
      };
    }
  }

  /**
   * Timeouts are necessary for large xml trees. This will cancel the call if the request is taking
   * too long, but will still allow the promises to resolve.
   *
   * @private
   * @param {string} url - url to use as a hash in the timeoutTable
   * @param {Promise} requester - the promise that creates the web request to the url
   */
  initializeTimeout(url, requester) {
    // this will throw a CancelError which will be handled in the parent that calls this method.
    this.timeoutTable[url] = setTimeout(() => requester.cancel(), this.timeout);
  }

  /**
   * Recursive function that will go through a sitemaps tree and get all the sites
   *
   * @private
   * @param {string} url - the Sitemaps url (e.g https://wp.seantburke.com/sitemap.xml)
   * @param {integer} retryIndex - number of retry attempts fro this URL (e.g. 0 for 1st attempt, 1 for second attempty etc.)
   * @param {Set<string>} [uniqueSites] - A Set accumulating the unique sites found so far across recursive calls.
   * @returns {Promise<SitesData>}
   */
  async crawl(url, retryIndex = 0, uniqueSites = new Set()) {
    try {
      if (uniqueSites.size >= this.limit) {
        if (this.debug) {
          console.debug(
            `Limit of ${this.limit} reached. Stopping crawl for ${url}. Current unique sites count: ${uniqueSites.size}`
          );
        }
        return { sites: uniqueSites, errors: [] };
      }

      const { error, data, type } = await this.parse(url);
      clearTimeout(this.timeoutTable[url]);

      if (error) {
        if (retryIndex < this.retries) {
          if (this.debug) {
            console.log(
              `(Retry attempt: ${retryIndex + 1} / ${
                this.retries
              }) ${url} due to ${data.name} on previous request`
            );
          }
          return this.crawl(url, retryIndex + 1, uniqueSites);
        }

        if (this.debug) {
          console.error(
            `Error occurred during "crawl('${url}')":\n\r Error: ${error}`
          );
        }

        return {
          sites: uniqueSites,
          errors: [
            {
              type: type || data.name,
              message: error,
              url,
              retries: retryIndex,
            },
          ],
        };
      } else if (data && data.urlset && data.urlset.url) {
        if (this.debug) {
          console.debug(`Urlset found during "crawl('${url}')"`);
        }

        const urlArray = Array.isArray(data.urlset.url)
          ? data.urlset.url
          : [data.urlset.url];

        const newSites = urlArray
          .filter((site) => {
            if (this.lastmod === 0) return true;
            if (site.lastmod === undefined) return false;
            const modified = new Date(site.lastmod).getTime();

            return modified >= this.lastmod;
          })
          .filter((site) => {
            return this.isIncluded(site.loc);
          })
          .filter((site) => {
            return !this.isExcluded(site.loc);
          })
          .map((site) => {
            if (!this.fields) {
              return site.loc;
            } else {
              let fields = {};
              if (this.fields.sitemap) {
                fields.sitemap = url;
              }
              for (const [field, active] of Object.entries(this.fields)) {
                if (active && site[field]) {
                  fields[field] = site[field];
                }
              }
              return fields;
            }
          });

        for (const site of newSites) {
          if (uniqueSites.size < this.limit) {
            // Only add if limit not reached
            uniqueSites.add(site);
          } else {
            if (this.debug) {
              console.debug(
                `Limit of ${this.limit} reached while adding sites from ${url}. Stopping further additions from this urlset.`
              );
            }
            break;
          }
        }

        if (this.debug) {
          console.debug(
            `Added ${newSites.length} potential sites from ${url}. Current unique total: ${uniqueSites.size}`
          );
        }

        return {
          sites: uniqueSites,
          errors: [],
        };
      } else if (data && data.sitemapindex) {
        // Handle child sitemaps found inside the active sitemap
        if (this.debug) {
          console.debug(`Additional sitemap found during "crawl('${url}')"`);
        }
        // Map each child url into a promise to create an array of promises
        const sitemapUrlsToCrawl = data.sitemapindex.sitemap
          .map((map) => map.loc)
          .filter((url) => {
            return !this.isExcluded(url);
          });

        let aggregatedErrors = [];

        for (const sitemapUrl of sitemapUrlsToCrawl) {
          if (uniqueSites.size >= this.limit) {
            if (this.debug) {
              console.debug(
                `Limit of ${this.limit} reached. Stopping further sequential child sitemap crawls from ${url}. Current unique total: ${uniqueSites.size}`
              );
            }
            break;
          }

          const { sites: childSites, errors: childErrors } = await this.crawl(
            sitemapUrl,
            0,
            uniqueSites
          );

          aggregatedErrors.push(...childErrors);
        }

        if (this.debug) {
          console.debug(
            `Finished crawling child sitemaps from ${url}. Current unique total sites after aggregation: ${uniqueSites.size}`
          );
        }

        return {
          sites: uniqueSites,
          errors: aggregatedErrors,
        };
      }

      if (retryIndex < this.retries) {
        if (this.debug) {
          console.log(
            `(Retry attempt: ${retryIndex + 1} / ${
              this.retries
            }) ${url} due to ${data.name} on previous request`
          );
        }
        return this.crawl(url, retryIndex + 1, uniqueSites);
      }
      if (this.debug) {
        console.error(`Unknown state during "crawl('${url})'":`, error, data);
      }

      return {
        sites: uniqueSites,
        errors: [
          {
            url,
            type: type || data.name || 'UnknownStateError',
            message: error,
            retries: retryIndex,
          },
        ],
      };
    } catch (e) {
      if (this.debug) {
        console.error(e);
      }
      return {
        sites: uniqueSites,
        errors: [
          { type: 'CrawlError', message: e.message, url, retries: retryIndex },
        ],
      };
    }
  }

  /**
   * Gets the sites from a sitemap.xml with a given URL
   *
   * @deprecated
   * @param {string} url - url to query
   * @param {getSitesCallback} callback - callback for sites and error
   * @callback
   */
  async getSites(url = this.url, callback) {
    console.warn(
      '\r\nWarning:',
      'function .getSites() is deprecated, please use the function .fetch()\r\n'
    );

    let err = {};
    let sites = [];
    try {
      const response = await this.fetch(url);
      sites = response.sites;
    } catch (error) {
      err = error;
    }
    return callback(err, sites);
  }

  /**
   * Decompress the gzipped response body using zlib.gunzip
   *
   * @param {Buffer} body - body of the gzipped file
   * @returns {boolean}
   */
  async decompressResponseBody(body) {
    return await new Promise((resolve, reject) => {
      const buffer = Buffer.from(body);
      zlib.gunzip(buffer, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
   * Checks if a urls is excluded based on the exclusion patterns.
   *
   * @param {string} url - The URL to check.
   * @returns {boolean} Returns true if the urls is excluded, false otherwise.
   */
  isExcluded(url) {
    if (this.exclusions.length === 0) return false;
    return this.exclusions.some((pattern) => pattern.test(url));
  }

  /**
   * Checks if a URL is included based on the inclusion patterns.
   *
   * @param {string} url - The URL to check.
   * @returns {boolean} Returns true if the URL matches any inclusion pattern, false otherwise.
   */
  isIncluded(url) {
    if (this.includes.length === 0) return true;
    return this.includes.some((pattern) => pattern.test(url));
  }
}

/**
 * Callback for the getSites method
 *
 * @callback getSitesCallback
 * @param {Object} error - error from callback
 * @param {Array} sites - an Array of sitemaps
 */

/**
 * Timeout in milliseconds
 *
 * @typedef {number} Timeout
 * the number of milliseconds before all requests timeout. The promises will still resolve so
 * you'll still receive parts of the request, but maybe not all urls
 * default is 15000 which is 15 seconds
 */

/**
 * Resolve handler type for the promise in this.parse()
 *
 * @typedef {Object} ParseData
 *
 * @property {Error} error that either comes from fast-xml-parser or `got` or custom error
 * @property {Object} data
 * @property {string} data.url - URL of sitemap
 * @property {Array} data.urlset - Array of returned URLs
 * @property {string} data.urlset.url - single Url
 * @property {Object} data.sitemapindex - index of sitemap
 * @property {string} data.sitemapindex.sitemap - Sitemap
 * @property {string} type - The type of result or error (e.g., 'Success', 'CancelError', 'HTTPError', 'RequestError')
 * @example {
 *   error: 'There was an error!'
 *   data: {
 *     url: 'https://linkedin.com',
 *     urlset: [{
 *       url: 'https://www.linkedin.com/project1'
 *     },[{
 *       url: 'https://www.linkedin.com/project2'
 *     }]
 *   }
 * }
 */

/**
 * Resolve handler type for the promise in this.parse()
 *
 * @typedef {Object} SitesData
 *
 * @property {string} url - the original url used to query the data
 * @property {SitesArray} sites
 * @property {ErrorDataArray} errors
 * @example {
 *   url: 'https://linkedin.com/sitemap.xml',
 *   sites: [
 *     'https://linkedin.com/project1',
 *     'https://linkedin.com/project2'
 *   ],
 *   errors: [
 *      {
 *        type: 'CancelError',
 *        url: 'https://www.walmart.com/sitemap_tp1.xml',
 *        retries: 0
 *      },
 *      {
 *        type: 'HTTPError',
 *        url: 'https://www.walmart.com/sitemap_tp2.xml',
 *        retries: 0
 *      },
 *   ]
 * }
 */

/**
 * An array of urls
 *
 * @typedef {string[]} SitesArray
 * @example [
 *   'https://www.google.com',
 *   'https://www.linkedin.com'
 * ]
 */

/**
 * An array of Error data objects
 *
 * @typedef {ErrorData[]} ErrorDataArray
 * @example [
 *    {
 *      type: 'CancelError',
 *      url: 'https://www.walmart.com/sitemap_tp1.xml',
 *      retries: 0
 *    },
 *    {
 *      type: 'HTTPError',
 *      url: 'https://www.walmart.com/sitemap_tp2.xml',
 *      retries: 0
 *    },
 * ]
 */

/**
 * An object containing details about the errors which occurred during the crawl
 *
 * @typedef {Object} ErrorData
 *
 * @property {string} type - The error type which was returned
 * @property {string} url - The sitemap URL which returned the error
 * @property {number} errors - The total number of retries attempted after receiving the first error
 * @example {
 *    type: 'CancelError',
 *    url: 'https://www.walmart.com/sitemap_tp1.xml',
 *    retries: 0
 * }
 */
