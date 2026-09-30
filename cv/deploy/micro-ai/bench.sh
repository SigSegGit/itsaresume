#!/bin/sh
# The same five small tasks on this machine's micro-AI (compose.yaml running):
# answer, time, and llama.cpp's own throughput. Run on the machine itself.
set -u
URL=${URL:-http://127.0.0.1:8095}
until curl -sf -o /dev/null http://127.0.0.1:8096/health; do sleep 2; done

run() {
  start=$(date +%s)
  out=$(curl -s -m 600 "$URL/$1" -H 'Content-Type: application/json' -d "$2")
  end=$(date +%s)
  printf '\n## %s (%ss)\n%s\n' "$3" "$((end - start))" "$out" | sed -E 's/"timings": \{[^}]*"prompt_per_second": ([0-9.]+)[^}]*"predicted_per_second": ([0-9.]+)[^}]*\}/"tok\/s": "prompt \1, generation \2"/'
}

run classify '{"text":"Solide expérience en développement digital et product engineering.","labels":["requis","souhaité"]}' 'classify: required line'
run classify '{"text":"Une connaissance de Kafka serait un plus.","labels":["requis","souhaité"]}' 'classify: optional line'
run equivalences '{"term":"Cycles de delivery","candidates":["GitLab CI","GitOps","ITIL","PostgreSQL","Terraform","Agile / Scrum","Pédagogie"]}' 'equivalences: delivery'
run equivalences '{"term":"Conteneurs","candidates":["Docker","Kubernetes","PostgreSQL","Ansible","Linux"]}' 'equivalences: containers'
run ask '{"question":"Que fait l entreprise Michelin et dans quel secteur est-elle ?","web":true}' 'ask with web search'
