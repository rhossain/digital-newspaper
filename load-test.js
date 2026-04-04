import http from 'k6/http';
import { sleep, check } from 'k6';

// Simulates 5000 unique visitors arriving over 2 minutes, each from a unique session.
// Each VU behaves like a real browser: loads the page once, then reads API data.
export const options = {
  scenarios: {
    unique_visitors: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 1000,
      stages: [
        { duration: '30s', target: 50  },  // ramp up gradually
        { duration: '1m',  target: 200 },  // peak load
        { duration: '30s', target: 0   },  // ramp down
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<3000'], // 95% of requests under 3s
    http_req_failed:   ['rate<0.05'],  // less than 5% failures
  },
};

const BASE_URL = 'https://diginews.rshossain.me';

export default function () {
  // Simulate unique browser session with unique cache-busting
  const sessionId = `session-${__VU}-${__ITER}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; LoadTest/1.0)',
    'X-Session-ID': sessionId,
    'Accept': 'text/html,application/json',
  };

  // 1. Load the homepage (first visit — no browser cache)
  const res1 = http.get(`${BASE_URL}/`, { headers });
  check(res1, { 'homepage OK': (r) => r.status === 200 });

  sleep(Math.random() * 2 + 1); // realistic 1-3s reading time

  // 2. Load newspaper data (API call Angular makes on init)
  const res2 = http.get(`${BASE_URL}/api/newspaper-data`, { headers });
  check(res2, { 'API OK': (r) => r.status === 200 });

  sleep(Math.random() * 3 + 2); // realistic 2-5s reading the newspaper
}
