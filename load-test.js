import http from 'k6/http';
import { sleep, check } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 500  },  // ramp up to 500 users
    { duration: '1m',  target: 5000 },  // ramp up to 5000 users
    { duration: '30s', target: 0    },  // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'], // 95% of requests under 2s
    http_req_failed:   ['rate<0.05'],  // less than 5% failures
  },
};

const BASE_URL = 'https://diginews.rshossain.me';

export default function () {
  // Test the main page
  const res1 = http.get(`${BASE_URL}/`);
  check(res1, { 'homepage OK': (r) => r.status === 200 });

  // Test the newspaper data API
  const res2 = http.get(`${BASE_URL}/api/newspaper-data`);
  check(res2, { 'API OK': (r) => r.status === 200 });

  sleep(1);
}
