package qq

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

var (
	reNuxtData = regexp.MustCompile(`(?s)<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>`)
	reFieldNum = regexp.MustCompile(`[A-Za-z_$][\w$]*\s*:\s*(\d{5,})`)
	reAnyNum   = regexp.MustCompile(`\b\d{5,}\b`)
	reSSID     = regexp.MustCompile(`\(\s*t\s*,\s*(\d{5,})\s*\)`)
)

// Client wraps the HTTP client used for page and media requests.
type Client struct {
	HTTP *http.Client
}

func NewClient() *Client {
	return &Client{HTTP: &http.Client{
		Timeout: 120 * time.Second,
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           dualStackDialContext,
			MaxIdleConns:          64,
			MaxIdleConnsPerHost:   16,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   20 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
		},
	}}
}

func (c *Client) get(ctx context.Context, url, cookie string) (string, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("User-Agent", browserUA)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return "", "", err
	}
	final := url
	if resp.Request != nil && resp.Request.URL != nil {
		final = resp.Request.URL.String()
	}
	if resp.StatusCode >= 400 {
		return string(body), final, fmt.Errorf("HTTP %d for %s", resp.StatusCode, final)
	}
	return string(body), final, nil
}

// FetchPage downloads a QQ channel post page, solving the EdgeOne cookie
// challenge when necessary. It returns the HTML and the final URL.
func (c *Client) FetchPage(ctx context.Context, url string) (string, string, error) {
	cookie := ""
	var lastBody string
	for attempt := 0; attempt < 6; attempt++ {
		body, final, err := c.get(ctx, url, cookie)
		if err != nil && body == "" {
			return "", final, err
		}
		lastBody = body
		if strings.Contains(body, "__NUXT_DATA__") {
			return body, final, nil
		}
		ck, ok := solveEdgeOne(body)
		if !ok {
			if strings.Contains(body, "__tst_status") || strings.Contains(body, "EO_Bot_Ssid") {
				return body, final, errors.New("EdgeOne challenge detected, but cookie could not be solved")
			}
			return body, final, fmt.Errorf("page did not contain Nuxt data (HTTP %s, %d bytes)", final, len(body))
		}
		cookie = ck
	}
	return lastBody, url, errors.New("EdgeOne challenge did not clear after retries")
}

var dualStackDialer = &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}

// dualStackDialContext retries over IPv4 when the system advertises an IPv6
// address but the host has no working IPv6 route.
var ipv4Cache sync.Map

func lookupIPv4(ctx context.Context, host string) []net.IP {
	if v, ok := ipv4Cache.Load(host); ok {
		return v.([]net.IP)
	}
	ips, _ := net.DefaultResolver.LookupIP(ctx, "ip4", host)
	if len(ips) == 0 {
		ips = dohIPv4(ctx, host)
	}
	if len(ips) > 0 {
		ipv4Cache.Store(host, ips)
	}
	return ips
}

// dohIPv4 asks Alibaba's DNS-over-HTTPS endpoint directly by IP. Some
// container resolvers return only AAAA for CDN hosts that also have A records;
// this recovers the IPv4 fallback without relying on the system resolver.
func dohIPv4(ctx context.Context, host string) []net.IP {
	u := "https://223.5.5.5/resolve?name=" + url.QueryEscape(host) + "&type=A"
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(c context.Context, network, addr string) (net.Conn, error) {
			return dialerForDoH.DialContext(c, "tcp4", "223.5.5.5:443")
		},
		TLSClientConfig: &tls.Config{ServerName: "dns.alidns.com"},
	}
	client := &http.Client{Timeout: 6 * time.Second, Transport: tr}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Accept", "application/dns-json")
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var parsed struct {
		Answer []struct {
			Type int    `json:"type"`
			Data string `json:"data"`
		} `json:"Answer"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&parsed); err != nil {
		return nil
	}
	out := make([]net.IP, 0, len(parsed.Answer))
	for _, answer := range parsed.Answer {
		if answer.Type != 1 {
			continue
		}
		if ip := net.ParseIP(strings.TrimSpace(answer.Data)); ip != nil && ip.To4() != nil {
			out = append(out, ip)
		}
	}
	return out
}

var dialerForDoH = &net.Dialer{Timeout: 6 * time.Second, KeepAlive: 30 * time.Second}

func dualStackDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if network == "tcp" {
		host, port, splitErr := net.SplitHostPort(addr)
		if splitErr == nil && net.ParseIP(host) == nil {
			for _, ip := range lookupIPv4(ctx, host) {
				conn4, err4 := dualStackDialer.DialContext(ctx, "tcp4", net.JoinHostPort(ip.String(), port))
				if err4 == nil {
					return conn4, nil
				}
			}
		}
	}
	return dualStackDialer.DialContext(ctx, network, addr)
}

// solveEdgeOne parses the obfuscated challenge script. The script contains a
// map of three numeric parts whose sum is __tst_status and a separate numeric
// session id used for EO_Bot_Ssid. No JavaScript engine is required.
func solveEdgeOne(body string) (string, bool) {
	if !strings.Contains(body, "__tst_status") && !strings.Contains(body, "EO_Bot_Ssid") {
		return "", false
	}
	var parts []int
	if i := strings.Index(body, "var e={"); i >= 0 {
		seg := body[i:]
		if j := strings.Index(seg, ",t=0"); j > 0 {
			seg = seg[:j]
		}
		for _, m := range reFieldNum.FindAllStringSubmatch(seg, -1) {
			if n, err := strconv.Atoi(m[1]); err == nil {
				parts = append(parts, n)
			}
		}
	}
	ssid := ""
	if m := reSSID.FindStringSubmatch(body); m != nil {
		ssid = m[1]
	}
	if len(parts) >= 3 {
		sum := 0
		for _, n := range parts[:3] {
			sum += n
		}
		ck := fmt.Sprintf("__tst_status=%d#", sum)
		if ssid != "" {
			ck += "; EO_Bot_Ssid=" + ssid
		}
		return ck, true
	}
	// Fallback: try each large literal as the session id.
	seen := map[string]bool{}
	var nums []string
	for _, n := range reAnyNum.FindAllString(body, -1) {
		if !seen[n] {
			seen[n] = true
			nums = append(nums, n)
		}
	}
	if len(nums) > 0 {
		if ssid != "" {
			return "EO_Bot_Ssid=" + ssid, true
		}
		return "EO_Bot_Ssid=" + nums[0], true
	}
	return "", false
}
