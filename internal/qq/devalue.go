package qq

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
)

// devalueDecoder decodes Nuxt's devalue flat-array payload.
// Element 1 is the root value. Positive integers are references to indices;
// negative integers and non-integers are literal values.
type devalueDecoder struct {
	arr   []interface{}
	cache map[int]interface{}
}

func decodeDevalue(data []byte) (interface{}, error) {
	var arr []interface{}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&arr); err != nil {
		return nil, fmt.Errorf("parse __NUXT_DATA__: %w", err)
	}
	if len(arr) < 2 {
		return nil, fmt.Errorf("__NUXT_DATA__ too short")
	}
	d := &devalueDecoder{arr: arr, cache: make(map[int]interface{})}
	return d.ref(1), nil
}

func (d *devalueDecoder) ref(i int) interface{} {
	if i < 0 || i >= len(d.arr) {
		return nil
	}
	if v, ok := d.cache[i]; ok {
		return v
	}
	x := d.arr[i]
	switch t := x.(type) {
	case map[string]interface{}:
		m := make(map[string]interface{}, len(t))
		d.cache[i] = m
		for k, v := range t {
			m[k] = d.value(v)
		}
		return m
	case []interface{}:
		if len(t) > 0 {
			if marker, ok := t[0].(string); ok {
				switch marker {
				case "Reactive", "ShallowReactive", "Ref", "ShallowRef", "EmptyRef", "ShallowReactiveRef":
					if len(t) > 1 {
						v := d.ref(d.index(t[1]))
						d.cache[i] = v
						return v
					}
					return nil
				case "Set":
					s := make([]interface{}, 0, len(t)-1)
					d.cache[i] = s
					for _, v := range t[1:] {
						s = append(s, d.value(v))
					}
					return s
				case "Map":
					m := make(map[string]interface{})
					d.cache[i] = m
					for j := 1; j+1 < len(t); j += 2 {
						m[toStr(d.value(t[j]))] = d.value(t[j+1])
					}
					return m
				case "Date", "BigInt", "RegExp", "URL", "Object":
					if len(t) > 1 {
						v := d.value(t[1])
						d.cache[i] = v
						return v
					}
					return nil
				}
			}
		}
		s := make([]interface{}, len(t))
		d.cache[i] = s
		for j, v := range t {
			s[j] = d.value(v)
		}
		return s
	default:
		d.cache[i] = x
		return x
	}
}

func (d *devalueDecoder) index(v interface{}) int {
	switch n := v.(type) {
	case json.Number:
		i, _ := strconv.Atoi(n.String())
		return i
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	}
	return -1
}

func (d *devalueDecoder) value(v interface{}) interface{} {
	switch t := v.(type) {
	case json.Number:
		s := t.String()
		if i, err := strconv.Atoi(s); err == nil {
			if i >= 0 {
				return d.ref(i)
			}
			return i
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return f
		}
		return s
	case float64:
		if t >= 0 && float64(int(t)) == t {
			return d.ref(int(t))
		}
		return t
	case int:
		if t >= 0 {
			return d.ref(t)
		}
		return t
	default:
		return v
	}
}
