import type { Metadata } from "next";

import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Termos de Serviço" };

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Documento oficial de uso"
      title="Termos de Serviço do Clipo"
      updated="29 de outubro de 2026 · Versão 1.3"
      other={{ href: "/privacidade", label: "Política de Privacidade" }}
      intro={
        <p>
          Ao usar o Clipo (gestão de mídia, corte de vídeo, legendas, inteligência artificial e agendamento para redes sociais),
          você concorda com estes Termos de Serviço. Leia com atenção antes de usar a plataforma.
        </p>
      }
      sections={[
        {
          title: "Visão geral e aceitação",
          body: (
            <>
              <p>
                O Clipo é um software que ajuda criadores, editores e agências a organizar, adaptar (por exemplo, para o formato
                9:16), legendar e agendar vídeos curtos nas redes que o próprio usuário conecta.
              </p>
              <p>
                Ao criar uma conta, você confirma ter pelo menos 18 anos (ou a maioridade da sua jurisdição), plena capacidade
                civil e concordância com estes Termos e com a Política de Privacidade.
              </p>
            </>
          ),
        },
        {
          title: "Serviços oferecidos",
          body: (
            <>
              <ul>
                <li>envio e armazenamento de vídeos;</li>
                <li>cortes manuais, divisão em partes e sugestões de corte por inteligência artificial;</li>
                <li>transcrição, legendas em arquivo e legendas gravadas no vídeo;</li>
                <li>ajuda com títulos, descrições e hashtags;</li>
                <li>agenda e publicação automática nas redes autorizadas pelo usuário (OAuth 2.0).</li>
              </ul>
              <p>
                O Clipo não garante visualizações, alcance, monetização ou resultado nas redes. É uma ferramenta de produtividade e
                publicação. Sugestões geradas por IA podem conter erros e devem ser revisadas por você.
              </p>
            </>
          ),
        },
        {
          title: "Integrações com plataformas de terceiros",
          body: (
            <>
              <ul>
                <li>
                  <strong>TikTok:</strong> Content Posting API oficial. Você deve seguir as Diretrizes da Comunidade e os Termos do
                  TikTok.
                </li>
                <li>
                  <strong>YouTube Data API:</strong> sujeita aos Termos de Serviço do YouTube e à Política de Privacidade do Google.
                </li>
                <li>
                  <strong>Meta Graph API:</strong> para contas profissionais do Instagram, conforme os Termos da Plataforma Meta.
                </li>
              </ul>
              <p>
                O Clipo é independente e não tem vínculo, parceria ou endosso de TikTok Inc., ByteDance Ltd., Google LLC ou Meta
                Platforms Inc. Você pode desconectar as redes a qualquer momento.
              </p>
            </>
          ),
        },
        {
          title: "Propriedade intelectual e conteúdo do usuário",
          body: (
            <>
              <p>
                <strong>Seu conteúdo continua seu.</strong> O Clipo não reivindica direitos sobre vídeos, áudios, imagens ou textos
                que você envia.
              </p>
              <p>
                <strong>Licença limitada:</strong> você concede ao Clipo uma licença técnica, temporária e não exclusiva só para
                processar, converter, transcrever, guardar e transmitir o conteúdo às redes que você autorizar.
              </p>
              <p>Ao enviar ou agendar vídeos, você declara que:</p>
              <ul>
                <li>tem os direitos autorais, de imagem e das trilhas sonoras;</li>
                <li>o conteúdo não viola marcas, patentes, segredos comerciais ou direitos de personalidade;</li>
                <li>o conteúdo não incita violência, discriminação, ódio, assédio ou práticas ilegais;</li>
                <li>o conteúdo respeita as diretrizes de cada rede onde será publicado.</li>
              </ul>
            </>
          ),
        },
        {
          title: "Conta e segurança",
          body: (
            <>
              <p>
                Você é responsável pela senha e pelas sessões abertas. O que for feito com suas credenciais é de sua
                responsabilidade.
              </p>
              <p>
                Para dar suporte, a equipe do Clipo pode, quando você pedir ou para investigar um problema, abrir uma sessão só de
                leitura na sua conta. Ela aparece para você na lista de aparelhos, dura no máximo 30 minutos e fica registrada.
              </p>
            </>
          ),
        },
        {
          title: "Planos, cobrança e cancelamento",
          body: (
            <>
              <p>
                Os planos têm limites de espaço, vídeos por mês, redes conectadas e créditos de IA. Ao atingir um limite, envios e
                processamentos novos podem ficar pausados até liberar espaço ou mudar de plano.
              </p>
              <p>
                A cobrança é recorrente (mensal ou anual) pelo Asaas, com Pix, boleto ou cartão. Você pode cancelar a qualquer
                momento: as cobranças param e o plano vale até o fim do período pago. Se um pagamento atrasar, o plano é mantido
                por um prazo de tolerância e depois a conta passa para o plano gratuito.
              </p>
            </>
          ),
        },
        {
          title: "Disponibilidade e limitação de responsabilidade",
          body: (
            <ul>
              <li>Os serviços são oferecidos como estão e conforme disponíveis.</li>
              <li>Não respondemos por instabilidades ou bloqueios causados pelas APIs das redes sociais.</li>
              <li>Não respondemos por penalidades, desmonetização ou suspensão aplicadas pelas redes aos perfis.</li>
              <li>Recomendamos manter cópias dos arquivos originais.</li>
            </ul>
          ),
        },
        {
          title: "Informações institucionais e contato",
          body: (
            <ul>
              <li>Aplicação: Clipo (plataforma web de edição e agendamento de vídeos)</li>
              <li>Responsável: [Razão social: Clipo Tecnologia]</li>
              <li>E-mail de suporte: [suporte@clipo.app]</li>
            </ul>
          ),
        },
      ]}
    />
  );
}
